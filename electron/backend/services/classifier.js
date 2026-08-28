'use strict';

// On-device statistical categorizer — phase 3 of import categorization, the
// recall layer, run after the precision-first lexicon (services/categorize.js).
// A multinomial Naive Bayes over word uni/bigrams of the
// normalized description, trained offline on synthetic data (scripts/
// train-categorizer.js) and shipped as a small JSON weight file. No network,
// no runtime training — pure arithmetic over the bundled weights.
//
// Precision is prioritised over recall. The model is trained with an explicit
// 'unknown' class (person payees, "<word> LLC", bank ops, gibberish), and
// predict() returns null unless the top *category* exceeds both 'unknown' and
// the runner-up category by a set margin, per known feature. A blank cell is an
// acceptable outcome; a wrong one is not. The gate's thresholds are calibrated
// at train time so the classifier miscategorizes none of the labeled corpus.

const { features } = require('./textFeatures');

let _model = null;
/** Load the shipped weights once, on first use. Deferred so requiring this
 *  module (e.g. from the trainer, which supplies its own in-memory model) does
 *  not require the weight file to exist. */
function getModel() {
  if (_model === null) _model = require('./categorizerModel.json');
  return _model;
}

/** Multinomial NB log-scores per class for a feature bag. Out-of-vocabulary
 *  features are skipped (standard) — an all-OOV description yields only the
 *  priors, which the minKnown gate then rejects. Pure. */
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

/** Predict a category key, or null when the gate is not met. Takes the model
 *  explicitly so the trainer calibrates against the same function used in
 *  production. */
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

  // Margins are divided by the known-feature count so the gate threshold
  // applies equally to a one-word and a five-word description.
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
