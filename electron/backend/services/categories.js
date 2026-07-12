'use strict';

// Category serialisation — port of services/categories.py.

const VALID_CAT_TYPES = ['income', 'expense', 'savings', 'investing'];

// The two seeded "Uncategorized" buckets — their `key` is hardcoded elsewhere
// (NULL_SYNC_KEYS in handlers/incomeExpenses.js, reportCard.js, creditCards.js,
// trends.js) to bucket NULL-category transactions, so renaming, retyping, or
// deleting them would silently break those aggregations. Write guards in
// handlers/categories.js block API drift; seed.js heals any pre-existing drift
// on every DB open, so the stored row is always canonical and no read path
// needs to special-case the name.
const SYSTEM_CATEGORY_KEYS = new Set(['uncat_income', 'uncat_expense']);

/** Position where a new category should land: the end of its own type's block,
 *  falling back through earlier types so same-type categories stay contiguous
 *  (mirror of insertPos in yearTable.js). Cash Flow columns and the ledger
 *  dropdown render in flat position order — a global MAX+1 append would park a
 *  new income category past Investing, where it looks like it never arrived.
 *  Callers must open the slot first: UPDATE position = position + 1 WHERE
 *  position >= the returned value. */
function insertPos(db, catType) {
  const lastOfType = (t) =>
    db
      .prepare('SELECT position FROM categories WHERE cat_type = ? ORDER BY position DESC')
      .get(t);
  const lastSame = lastOfType(catType);
  if (lastSame) return lastSame.position + 1;
  const idx = VALID_CAT_TYPES.indexOf(catType);
  for (const earlier of VALID_CAT_TYPES.slice(0, idx).reverse()) {
    const last = lastOfType(earlier);
    if (last) return last.position + 1;
  }
  return 0;
}

function serialiseCategory(c) {
  return {
    id: c.id,
    key: c.key,
    name: c.name,
    cat_type: c.cat_type,
    position: c.position,
    locked: SYSTEM_CATEGORY_KEYS.has(c.key),
  };
}

module.exports = { VALID_CAT_TYPES, SYSTEM_CATEGORY_KEYS, insertPos, serialiseCategory };
