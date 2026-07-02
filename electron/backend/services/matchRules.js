'use strict';

// Learned auto-categorization — port of services/match_rules.py.
//
// The fuzzy thresholds (0.92 here for unattended matches, 0.85 for the
// interactive Categorize Similar) were tuned against Python's
// difflib.SequenceMatcher.ratio(), so `sequenceRatio` below is a faithful
// port of that exact algorithm (Ratcliff/Obershelp with autojunk, isjunk=None).
// Its numeric output is verified equal to Python's across a fixture oracle in
// __tests__/matchRules.test.js — do not "simplify" it without re-checking parity.

const AUTO_FUZZY_THRESHOLD = 0.92;

// The single user-facing match-strength control (tx_fuzzy_threshold) for the
// interactive "Categorize Similar" pass: 1.0 = exact (the default), lower =
// progressively fuzzier. The slider clamps to [MIN, MAX]. The unattended
// auto-match bar (AUTO_FUZZY_THRESHOLD above) stays fixed and stricter; the
// slider only gates *whether* fuzzy auto-match runs at all (threshold < 1).
const DEFAULT_MATCH_THRESHOLD = 1.0;
const FUZZY_THRESHOLD_MIN = 0.5;
const FUZZY_THRESHOLD_MAX = 1.0;

// ─── difflib.SequenceMatcher.ratio() port ────────────────────────────────────

/** Build b2j (element -> sorted index list), applying difflib's autojunk:
 *  for b of length >= 200, elements occurring more than n/100+1 times are
 *  dropped so they can't seed matches (isjunk is always None in our usage). */
function buildB2J(b) {
  const n = b.length;
  const b2j = new Map();
  for (let i = 0; i < n; i++) {
    const ch = b[i];
    let arr = b2j.get(ch);
    if (!arr) { arr = []; b2j.set(ch, arr); }
    arr.push(i);
  }
  if (n >= 200) {
    const ntest = Math.floor(n / 100) + 1;
    for (const [ch, idxs] of b2j) {
      if (idxs.length > ntest) b2j.delete(ch);
    }
  }
  return b2j;
}

function findLongestMatch(a, b, b2j, alo, ahi, blo, bhi) {
  let besti = alo, bestj = blo, bestsize = 0;
  let j2len = new Map();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map();
    const idxs = b2j.get(a[i]);
    if (idxs) {
      for (const j of idxs) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
    }
    j2len = newj2len;
  }
  // isjunk=None -> no junk elements, so only the non-junk boundary extension
  // runs (the junk-aware passes in CPython are no-ops here).
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    besti--; bestj--; bestsize++;
  }
  while (besti + bestsize < ahi && bestj + bestsize < bhi
         && a[besti + bestsize] === b[bestj + bestsize]) {
    bestsize++;
  }
  return { i: besti, j: bestj, size: bestsize };
}

/** 2.0*M/T over the matching blocks — identical to difflib's ratio(). */
function sequenceRatio(a, b) {
  const la = a.length, lb = b.length;
  if (la + lb === 0) return 1.0; // difflib: ratio of two empty sequences is 1.0
  const b2j = buildB2J(b);
  let matches = 0;
  const queue = [[0, la, 0, lb]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const m = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi);
    if (m.size) {
      matches += m.size;
      if (alo < m.i && blo < m.j) queue.push([alo, m.i, blo, m.j]);
      if (m.i + m.size < ahi && m.j + m.size < bhi) {
        queue.push([m.i + m.size, ahi, m.j + m.size, bhi]);
      }
    }
  }
  return (2.0 * matches) / (la + lb);
}

// ─── Rule logic ───────────────────────────────────────────────────────────────

/** Canonical rule pattern: lowercased, whitespace-collapsed (port of _normalise). */
function normalise(desc) {
  return String(desc == null ? '' : desc).toLowerCase().trim().split(/\s+/).join(' ');
}

function getSetting(db, key, dflt) {
  const row = db.prepare('SELECT value FROM app_settings WHERE "key" = ?').get(key);
  return row ? row.value : dflt;
}

function autoMatchEnabled(db) {
  return getSetting(db, 'tx_auto_match', 'on') !== 'off';
}

/** User-tuned interactive match bar, clamped to the slider's range. A garbage
 *  or out-of-range stored value falls back to the default rather than throwing. */
function getFuzzyThreshold(db) {
  const n = Number(getSetting(db, 'tx_fuzzy_threshold', String(DEFAULT_MATCH_THRESHOLD)));
  if (!Number.isFinite(n)) return DEFAULT_MATCH_THRESHOLD;
  return Math.min(FUZZY_THRESHOLD_MAX, Math.max(FUZZY_THRESHOLD_MIN, n));
}

/** Upsert the rule for a description after a user assignment (last decision wins). */
function recordMatch(db, description, categoryId) {
  const pattern = normalise(description);
  if (!pattern) return;
  const existing = db.prepare('SELECT id FROM match_rules WHERE pattern = ?').get(pattern);
  if (existing) {
    db.prepare('UPDATE match_rules SET category_id = ? WHERE id = ?').run(categoryId, existing.id);
  } else {
    db.prepare('INSERT INTO match_rules (pattern, category_id) VALUES (?, ?)').run(pattern, categoryId);
  }
}

/** Drop the rule for a description (user explicitly un-categorized the row). */
function forgetMatch(db, description) {
  const pattern = normalise(description);
  if (pattern) db.prepare('DELETE FROM match_rules WHERE pattern = ?').run(pattern);
}

/**
 * Confidently-matching category_id for a description, or null. `rules` is the
 * full rule list (loaded once by the caller); `fuzzy` is whether the fuzzy pass
 * is enabled (match strength below 100%). Pure.
 */
function autoMatchCategory(description, rules, fuzzy) {
  const pattern = normalise(description);
  if (!pattern) return null;

  for (const r of rules) {
    if (r.pattern === pattern) return r.category_id; // exact — certain
  }
  if (!fuzzy) return null;

  // Fuzzy: every rule clearing the bar must name one category, else ambiguous.
  const candidates = new Set();
  for (const r of rules) {
    if (sequenceRatio(pattern, r.pattern) >= AUTO_FUZZY_THRESHOLD) {
      candidates.add(r.category_id);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

/**
 * Auto-categorize the uncategorized tx-like objects in place (each has
 * {description, category_id, tx_type}); returns the count categorized. The
 * caller inserts/commits. Mirrors apply_auto_match.
 */
function applyAutoMatch(db, transactions) {
  if (!autoMatchEnabled(db)) return 0;
  const rules = db.prepare('SELECT pattern, category_id FROM match_rules').all();
  if (!rules.length) return 0;

  // Fuzzy auto-match runs only when the match-strength slider is below 100%.
  const fuzzy = getFuzzyThreshold(db) < 1;
  const catTypes = new Map(
    db.prepare('SELECT id, cat_type FROM categories').all().map((c) => [c.id, c.cat_type])
  );

  let n = 0;
  for (const t of transactions) {
    if (t.category_id != null || !t.description) continue;
    // A transfer never takes a category — matching one by description (e.g. a
    // learned rule for "ZELLE TO SAVINGS") would flip its direction to the
    // category's cat_type and break its pairing.
    if (t.tx_type === 'transfer_in' || t.tx_type === 'transfer_out') continue;
    const catId = autoMatchCategory(t.description, rules, fuzzy);
    if (catId == null || !catTypes.has(catId)) continue;
    t.category_id = catId;
    t.tx_type = catTypes.get(catId);
    n++;
  }
  return n;
}

module.exports = {
  AUTO_FUZZY_THRESHOLD,
  DEFAULT_MATCH_THRESHOLD,
  sequenceRatio,
  normalise,
  getSetting,
  autoMatchEnabled,
  getFuzzyThreshold,
  recordMatch,
  forgetMatch,
  autoMatchCategory,
  applyAutoMatch,
};
