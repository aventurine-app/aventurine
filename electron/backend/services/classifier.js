'use strict';

// On-device statistical categorizer — Phase 3 of the import moat, the RECALL
// layer that runs after the precision-first lexicon (services/categorize.js)
// has had first pick. A multinomial Naive Bayes over word uni/bigrams of the
// normalized description, trained offline on synthetic data (scripts/
// train-categorizer.js) and shipped as a small JSON weight file. No network,
// no runtime training — pure arithmetic over the bundled weights.
//
// PRECISION IS THE JOB. The model is trained with an explicit 'unknown' class
// (person payees, "<word> LLC", bank ops, gibberish), and predict() abstains
// unless the top *category* decisively beats both 'unknown' and the runner-up
// category, per known feature. A blank cell is a good outcome; a wrong one is
// not. The abstention gate's thresholds are calibrated at train time so the
// classifier never miscategorizes the labeled corpus.

const path = require('path');
const { features } = require('./textFeatures');

let _model = null;
/** Lazily load the shipped weights (once). Kept lazy so requiring this module
 *  (e.g. from the trainer, which supplies its own in-memory model) never needs
 *  the artifact to exist. */
function getModel() {
  if (_model === null) _model = require('./categorizerModel.json');
  return _model;
}

/** Multinomial NB log-scores per class for a feature bag. Out-of-vocabulary
 *  features are ignored (standard) — an all-OOV description yields only the
 *  priors and is caught by the minKnown gate. Pure. */
function scoreDocument(model, feats) {
  const scores = model.logPrior.slice();
  let known = 0;
  for (const f of feats) {
    const row = model.logLik[f];
    if (!row) continue;
    known++;
    for (let c = 0; c < scores.length; c++) scores[c] += row[c];
  }
  return { scores, known };
}

/** Predict a category key, or null to abstain. Explicit-model form so the
 *  trainer can calibrate against the very function that runs in production. */
function predictWithModel(model, description) {
  const { scores, known } = scoreDocument(model, features(description));
  if (known < model.gate.minKnown) return null;

  const { classes } = model;
  const unkIdx = classes.indexOf('unknown');
  let top = -1;
  let second = -1;
  for (let c = 0; c < classes.length; c++) {
    if (c === unkIdx) continue;
    if (top < 0 || scores[c] > scores[top]) {
      second = top;
      top = c;
    } else if (second < 0 || scores[c] > scores[second]) {
      second = c;
    }
  }

  // Margins are per-known-feature so the gate means the same thing for a
  // one-word and a five-word description.
  const marginUnknown = (scores[top] - scores[unkIdx]) / known;
  const marginRunner = second < 0 ? Infinity : (scores[top] - scores[second]) / known;
  if (marginUnknown < model.gate.marginUnknown) return null;
  if (marginRunner < model.gate.marginRunner) return null;

  return { categoryKey: classes[top], confidence: model.gate.confidence, source: 'classifier' };
}

/** Classify with the shipped model. Returns {categoryKey, confidence, source}
 *  or null. */
function classify(description) {
  return predictWithModel(getModel(), description);
}

module.exports = { scoreDocument, predictWithModel, classify, getModel };
