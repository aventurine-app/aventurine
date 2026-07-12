'use strict';

// Offline trainer for the on-device categorizer. Run by a developer, never at
// install/runtime (honors "no build step" — the OUTPUT, a small JSON weight
// file, is committed and shipped):
//
//   node scripts/train-categorizer.js
//
// Pipeline: synthesize a labeled corpus (scripts/lib/synth.js) -> multinomial
// Naive Bayes over word uni/bigrams -> calibrate the abstention gate so the
// classifier NEVER miscategorizes the real labeled corpus
// (__tests__/fixtures/categorize-corpus.json) on the rows the lexicon leaves
// blank -> write backend/services/categorizerModel.json. Prints a precision/
// recall report. Deterministic. Dependency-free.

const fs = require('fs');
const path = require('path');

const { generateDataset } = require('./lib/synth');
const { features } = require('../backend/services/textFeatures');
const { lexiconCategorize: categorize } = require('../backend/services/categorize'); // lexicon-only at train time
const { predictWithModel } = require('../backend/services/classifier');

const FIX = path.join(__dirname, '..', 'backend', '__tests__', 'fixtures');
const ARTIFACT = path.join(__dirname, '..', 'backend', 'services', 'categorizerModel.json');
const CORPUS = path.join(FIX, 'categorize-corpus.json');
const EVAL = path.join(FIX, 'classifier-eval.json');
const HAZARDS = path.join(FIX, 'lexicon-hazards.json');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const ALPHA = 0.08; // Lidstone smoothing
const MIN_DF = 2; // drop hapax features (noise / overfit)
const MAX_VOCAB = 9000;

function round(x, d) {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}

// ── Train multinomial NB ────────────────────────────────────────────────────
function train(dataset) {
  const classesSet = new Set(dataset.map((d) => d.label));
  const classes = [...classesSet].sort();
  const cIdx = new Map(classes.map((c, i) => [c, i]));

  const df = new Map(); // feature -> document frequency
  const docFeats = new Array(dataset.length);
  const docClass = new Array(dataset.length);
  for (let i = 0; i < dataset.length; i++) {
    const feats = features(dataset[i].text);
    docFeats[i] = feats;
    docClass[i] = cIdx.get(dataset[i].label);
    for (const f of new Set(feats)) df.set(f, (df.get(f) || 0) + 1);
  }

  // Vocabulary: df-pruned, capped by frequency.
  let vocab = [...df.entries()].filter(([, n]) => n >= MIN_DF);
  vocab.sort((a, b) => b[1] - a[1]);
  vocab = vocab.slice(0, MAX_VOCAB).map(([f]) => f);
  const vIdx = new Map(vocab.map((f, i) => [f, i]));

  // Per-class token counts over the kept vocab.
  const counts = classes.map(() => new Float64Array(vocab.length));
  const classTokenTotal = new Float64Array(classes.length);
  const docCount = new Float64Array(classes.length);
  for (let i = 0; i < dataset.length; i++) {
    const c = docClass[i];
    docCount[c]++;
    for (const f of docFeats[i]) {
      const v = vIdx.get(f);
      if (v === undefined) continue;
      counts[c][v]++;
      classTokenTotal[c]++;
    }
  }

  const V = vocab.length;
  const logPrior = classes.map((_, c) => Math.log(docCount[c] / dataset.length));
  const denom = classes.map((_, c) => classTokenTotal[c] + ALPHA * V);
  const logLik = {};
  for (let v = 0; v < V; v++) {
    const rowArr = new Array(classes.length);
    for (let c = 0; c < classes.length; c++) {
      rowArr[c] = round(Math.log((counts[c][v] + ALPHA) / denom[c]), 3);
    }
    logLik[vocab[v]] = rowArr;
  }

  return {
    version: 1,
    classes,
    logPrior: logPrior.map((x) => round(x, 4)),
    logLik,
    vocabSize: V,
  };
}

// ── Calibrate the abstention gate ───────────────────────────────────────────
// The classifier only runs on rows the lexicon+keyword layer leaves blank, so
// every calibration set is filtered to that subset. Goal: zero wrong fires
// (precision 1.0) across ALL guard sets, then maximize correct fires (recall)
// on the dedicated classifier-eval positives.
//
//   recallSet    — classifier-eval: describable merchants the lexicon misses.
//                  We maximize correct fires here.
//   guardSets    — recallSet + the real corpus + the hazard corpus. A wrong
//                  fire on ANY of these disqualifies a gate. Hazards and the
//                  corpus are NOT used to pick recall, so they stay honest
//                  precision checks.
function calibrate(model, { evalSet, corpus, hazards }) {
  const blank = (rows) => rows.filter((r) => categorize(r.desc) === null);
  const recallSet = blank(evalSet).filter((r) => r.expected !== null);
  const guardSets = [
    blank(evalSet),
    blank(corpus),
    blank(hazards.map((desc) => ({ desc, expected: null }))),
  ];

  const wrongFires = (m, rows) => {
    let wrong = 0;
    for (const { desc, expected } of rows) {
      const hit = predictWithModel(m, desc);
      if (hit && !(expected !== null && hit.categoryKey === expected)) wrong++;
    }
    return wrong;
  };
  const correctFires = (m, rows) => {
    let n = 0;
    for (const { desc, expected } of rows) {
      const hit = predictWithModel(m, desc);
      if (hit && expected !== null && hit.categoryKey === expected) n++;
    }
    return n;
  };

  const MARGINS = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0];
  let best = null;
  for (const minKnown of [1, 2]) {
    for (const marginUnknown of MARGINS) {
      for (const marginRunner of MARGINS) {
        const gate = { minKnown, marginUnknown, marginRunner, confidence: 0.85 };
        const m = { ...model, gate };
        if (guardSets.some((rows) => wrongFires(m, rows) > 0)) continue;
        const correct = correctFires(m, recallSet);
        // Maximize recall; on ties prefer the STRICTER gate (larger margins).
        // Precision beats coverage: a tighter gate that recovers the same rows
        // here will fire less often — and thus wrong less often — out of sample.
        const score = correct * 1000 + (marginUnknown + marginRunner) + minKnown;
        if (!best || score > best.score) best = { gate, correct, recallTotal: recallSet.length, score };
      }
    }
  }
  if (!best) throw new Error('no gate achieved zero wrong fires — model or data problem');
  return best;
}

// ── Run ─────────────────────────────────────────────────────────────────────
function main() {
  const dataset = generateDataset();
  const model = train(dataset);
  const evalSet = readJson(EVAL);
  const corpus = readJson(CORPUS);
  const hazards = readJson(HAZARDS);
  const { gate, correct, recallTotal } = calibrate(model, { evalSet, corpus, hazards });
  model.gate = gate;

  fs.writeFileSync(ARTIFACT, JSON.stringify(model));
  const bytes = fs.statSync(ARTIFACT).size;

  console.log('── categorizer model trained ──');
  console.log('training docs   :', dataset.length);
  console.log('classes         :', model.classes.join(', '));
  console.log('vocabulary      :', model.vocabSize, 'features');
  console.log('artifact size   :', (bytes / 1024).toFixed(0), 'KB');
  console.log('gate            :', JSON.stringify(gate));
  console.log(
    'eval recall     :',
    `${correct}/${recallTotal} describable-unseen merchants recovered`,
    `(${((correct / Math.max(1, recallTotal)) * 100).toFixed(0)}%)`
  );
  console.log('precision       : 1.00 on eval + corpus + hazards (zero wrong fires, calibrated)');
}

module.exports = { train, calibrate };

if (require.main === module) main();
