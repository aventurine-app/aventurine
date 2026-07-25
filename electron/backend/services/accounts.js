'use strict';

// Accounts — the Balance Sheet's columns, which double as the accounts a
// transaction can belong to (transactions.account_key references
// balance_columns."key"; see the v10 migration). This service owns the one
// thing the generic year-table factory can't: ADOPTION of a starter account.
//
// A fresh database seeds the starter accounts hidden (seed.js
// DEFAULT_BALANCE_COLUMNS): they exist so onboarding and the import picker can
// offer stably-keyed, pre-named choices ("Checking", "Credit Card"), but they
// are invisible everywhere else until the user actually adopts one. Adoption is
// deliberately a side effect of USE — an import landing in the account — not of
// picking it in a list, so an abandoned onboarding leaves nothing behind.

const BAL_TYPE_ORDER = ['cash', 'investment', 'retirement', 'debt'];

/** Position where a newly visible account should land: the end of its own
 *  type's block, falling back through earlier types so same-type accounts stay
 *  contiguous (mirror of insertPos in services/categories.js and yearTable.js).
 *  Only VISIBLE accounts count — the starter accounts are parked outside the
 *  display order, so they must not push a real account past its type group.
 *  Callers open the slot first: UPDATE position = position + 1 WHERE
 *  position >= the returned value. */
function insertPos(db, colType) {
  const lastOfType = (t) =>
    db
      .prepare(
        'SELECT position FROM balance_columns WHERE hidden = 0 AND col_type = ? ORDER BY position DESC'
      )
      .get(t);
  const lastSame = lastOfType(colType);
  if (lastSame) return lastSame.position + 1;
  const idx = BAL_TYPE_ORDER.indexOf(colType);
  for (const earlier of BAL_TYPE_ORDER.slice(0, idx).reverse()) {
    const last = lastOfType(earlier);
    if (last) return last.position + 1;
  }
  return 0;
}

/**
 * Adopt a starter account: make it visible and give it a real slot in the
 * display order (until now it had none). Idempotent and safe to call for any
 * key — an account that is already visible, or a key that names nothing, is
 * left alone. Returns true only when this call is what revealed it, so a caller
 * can report "your Checking account is now on the Balance Sheet" exactly once.
 *
 * Must run inside the caller's transaction: it renumbers neighbouring rows.
 */
function adoptAccount(db, key) {
  const col = db.prepare('SELECT * FROM balance_columns WHERE "key" = ?').get(key);
  if (!col || !col.hidden) return false;
  const pos = insertPos(db, col.col_type);
  db.prepare('UPDATE balance_columns SET position = position + 1 WHERE position >= ?').run(pos);
  db.prepare('UPDATE balance_columns SET hidden = 0, position = ? WHERE id = ?').run(pos, col.id);
  return true;
}

module.exports = { BAL_TYPE_ORDER, insertPos, adoptAccount };
