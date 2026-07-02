'use strict';

// Transaction field application + serialisation — port of
// services/transactions.py. Rows are plain objects mirroring the
// `transactions` table columns; dates are ISO 'YYYY-MM-DD' strings end-to-end.

const { isFiniteNumber, parseIsoDate, round2 } = require('../validate');

// The transfer pair types mark money moving BETWEEN the user's own accounts
// ('transfer_out' of the source, 'transfer_in' to the target, linked via
// transfer_peer_id). They never carry a category, and every income/spend
// aggregation excludes them — a transfer is not earning or spending.
const TRANSFER_TYPES = ['transfer_in', 'transfer_out'];
const TX_TYPES = ['income', 'expense', 'savings', 'investing', ...TRANSFER_TYPES];

/**
 * Shape a transaction row for JSON output (mirror of _serialise_tx).
 * Direction is owned by the category: when the row is categorized and a
 * {category_id -> cat_type} Map is supplied, tx_type is derived from it so
 * rows written before a category was re-typed still render correctly.
 */
function serialiseTx(t, catTypeById = null) {
  let txType = t.tx_type;
  if (t.category_id != null && catTypeById) {
    txType = catTypeById.get(t.category_id) ?? txType;
  }
  return {
    id: t.id,
    date: t.date || null,
    description: t.description,
    category_id: t.category_id,
    tx_type: txType,
    amount: t.amount,
    notes: t.notes,
    account_id: t.account_id ?? null,
    transfer_peer_id: t.transfer_peer_id ?? null,
  };
}

/**
 * Apply and validate editable fields onto a transaction object (mirror of
 * _apply_tx_fields; takes `db` for the category existence lookup).
 * requireAll=true on create; false on update (only present keys touched).
 * Returns an error string on failure, null on success.
 *
 * Direction rule: a categorized transaction always takes tx_type from
 * Category.cat_type; an explicit tx_type only applies while category_id is
 * NULL (the one case with no category to derive from).
 */
function applyTxFields(db, t, data, { requireAll }) {
  if ('date' in data || requireAll) {
    const d = parseIsoDate(data.date);
    if (!d) return 'invalid date (expected YYYY-MM-DD)';
    t.date = d;
  }
  if ('description' in data || requireAll) {
    const val = 'description' in data ? data.description : '';
    if (typeof val !== 'string') return 'invalid description';
    t.description = val.slice(0, 200);
  }
  if ('category_id' in data) {
    const val = data.category_id;
    if (val !== null && (typeof val !== 'number' || !Number.isInteger(val))) {
      return 'invalid category_id';
    }
    // A transfer is not earning or spending, so it can never take a category;
    // the row must be converted back to a plain type first. Without this
    // guard, categorizing would silently flip the row's direction to the
    // category's cat_type and orphan its transfer_peer_id pairing.
    if (val !== null && TRANSFER_TYPES.includes(t.tx_type)) {
      return 'a transfer cannot be categorized';
    }
    let cat = null;
    if (val !== null) {
      cat = db.prepare('SELECT id, cat_type FROM categories WHERE id = ?').get(val);
      if (!cat) return 'unknown category_id';
    }
    t.category_id = val;
    if (cat) t.tx_type = cat.cat_type;
  }
  if ('account_id' in data) {
    const val = data.account_id;
    if (val !== null && (typeof val !== 'number' || !Number.isInteger(val))) {
      return 'invalid account_id';
    }
    if (val !== null && !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(val)) {
      return 'unknown account_id';
    }
    t.account_id = val;
  }
  if ('tx_type' in data || requireAll) {
    const val = 'tx_type' in data ? data.tx_type : 'expense';
    if (!TX_TYPES.includes(val)) return 'invalid tx_type';
    if (t.category_id == null) t.tx_type = val;
  }
  if ('amount' in data || requireAll) {
    const val = data.amount;
    if (!isFiniteNumber(val)) return 'invalid amount';
    // Positive magnitude, rounded to cents at the write boundary.
    t.amount = round2(Math.abs(val));
  }
  if ('notes' in data) {
    const val = data.notes;
    if (typeof val !== 'string') return 'invalid notes';
    t.notes = val.slice(0, 500);
  }
  return null;
}

/** Insert a tx object built by applyTxFields; fills defaults, returns with id. */
function insertTx(db, t) {
  const info = db
    .prepare(
      `INSERT INTO transactions
         (date, description, category_id, tx_type, amount, notes, account_id, transfer_peer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      t.date,
      t.description ?? '',
      t.category_id ?? null,
      t.tx_type ?? 'expense',
      t.amount ?? 0,
      t.notes ?? '',
      t.account_id ?? null,
      t.transfer_peer_id ?? null
    );
  t.id = info.lastInsertRowid;
  return t;
}

/** Persist the editable fields of an existing tx object (by t.id). */
function updateTx(db, t) {
  db.prepare(
    `UPDATE transactions
        SET date = ?, description = ?, category_id = ?, tx_type = ?, amount = ?, notes = ?,
            account_id = ?, transfer_peer_id = ?
      WHERE id = ?`
  ).run(
    t.date,
    t.description,
    t.category_id,
    t.tx_type,
    t.amount,
    t.notes,
    t.account_id ?? null,
    t.transfer_peer_id ?? null,
    t.id
  );
}

/** Fresh tx object with the model's column defaults (mirror of Transaction()). */
function newTx() {
  return {
    id: null,
    date: null,
    description: '',
    category_id: null,
    tx_type: 'expense',
    amount: 0,
    notes: '',
    account_id: null,
    transfer_peer_id: null,
  };
}

module.exports = {
  TX_TYPES,
  TRANSFER_TYPES,
  serialiseTx,
  applyTxFields,
  insertTx,
  updateTx,
  newTx,
};
