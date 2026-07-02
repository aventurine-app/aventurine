'use strict';

// Derived Balance Sheet values — the read-time bridge from the transaction
// ledger to the Balance Sheet. For every account that names the Balance Sheet
// column it feeds (accounts.balance_column), this rolls the account's balance
// anchors (statement balances from imported files, or the one number the user
// typed) through its transactions to produce month-end balances — so a single
// file drop lights up net worth without hand-entering history.
//
// The guiding rules:
//   - The TREND is the product. The latest anchor rolls through the whole
//     ledger, so five years of imported transactions become five years of
//     month-end history. A gap between the anchor and the ledger offsets
//     every rolled LEVEL by one unknown constant (the gap's net flow) but
//     never bends the SHAPE of change over time — see
//     deriveAccountMonthEnds for the full reasoning.
//   - The USER decides which columns derive. Per-(year, column) sync
//     (balance_sync, the twin of Cash Flow's category_sync) controls whether
//     a column's cells are computed from its linked accounts or hand-
//     entered: synced cells are read-only and ignore stored values (which
//     survive for when the user opts back out); unsynced columns never show
//     derived data. Linked columns default into sync; opt-out is per year.
//
// Mostly pure logic + read-only queries; the two seeding helpers
// (ensureBalanceYear, seedNewlyLinkedColumn) write sync-membership rows and
// run inside their callers' transactions.

const { round2, VALID_MONTHS } = require('../validate');

/** Last day of a 'YYYY-MM' month as an ISO date. */
function monthEnd(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const last = new Date(y, m, 0).getDate(); // day 0 of next month
  return `${monthKey}-${String(last).padStart(2, '0')}`;
}

/** Ascending 'YYYY-MM' keys spanning two ISO dates, inclusive. */
function monthKeysBetween(startIso, endIso) {
  const keys = [];
  let [y, m] = [Number(startIso.slice(0, 4)), Number(startIso.slice(5, 7))];
  const [ey, em] = [Number(endIso.slice(0, 4)), Number(endIso.slice(5, 7))];
  while (y < ey || (y === ey && m <= em)) {
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return keys;
}

/** A row's effect on its own account's balance, with direction resolved the
 *  same way as everywhere else: a categorized row follows Category.cat_type,
 *  an uncategorized row its stored tx_type. Inflows (income, transfer_in) are
 *  positive; every outflow is negative. */
function signedFor(t, catTypes) {
  const dir = t.category_id != null ? catTypes.get(t.category_id) ?? t.tx_type : t.tx_type;
  return dir === 'income' || dir === 'transfer_in' ? t.amount : -t.amount;
}

/**
 * Month values for one account, or null when it has no observations at all.
 * `txs` must be this account's rows sorted by date ascending; `anchors` its
 * balance observations. Two layers, weakest first:
 *
 *   1. POINT months — every anchor is a plain fact about its own month:
 *      "the latest observed balance in that month". An anchors-only account
 *      (a 401k the user updates monthly, with no transaction files)
 *      populates month by month from these alone.
 *   2. ROLLED months — the LATEST anchor (one coherent reference, no
 *      per-month jumps between disagreeing statements) is rolled through the
 *      transactions: balance(E) = anchorBalance + Σ signed(tx in
 *      (anchorDate, E]) — algebraically the same forward or backward. Every
 *      month from the earlier of (first transaction, anchor) to the later of
 *      (last transaction, anchor) gets its balance at its last covered day:
 *      true month-end for past months, the latest known balance in the final
 *      month. Rolled values overwrite point values — a month-end beats a
 *      mid-month observation.
 *
 * A gap between the anchor and the ledger (a "balance today" typed weeks
 * after the newest imported row, or an old statement balance) is treated as
 * quiet. That can offset the LEVEL of every rolled month by one unknown
 * constant — the gap's net flow — but it never distorts the SHAPE of change
 * over time, and the trend is what the Balance Sheet and the net-worth chart
 * exist to show. (An earlier version refused to bridge such gaps; five years
 * of imported history then produced a single dot, which protected the level
 * by destroying the graph.) File anchors are the bank's own statement
 * numbers and carry no such approximation; importing a fresher statement
 * closes a manual gap and snaps levels exact.
 */
function deriveAccountMonthEnds(txs, anchors, catTypes) {
  if (!anchors.length) return null;

  // Layer 1 — point months. Ascending order so the newest observation in a
  // month wins; a same-date file (statement) balance beats a manual one.
  const bySourceThenDate = (a, b) =>
    a.date === b.date
      ? (a.source === 'file' ? 1 : 0) - (b.source === 'file' ? 1 : 0)
      : a.date < b.date ? -1 : 1;
  const ordered = [...anchors].sort(bySourceThenDate);
  const points = {};
  for (const a of ordered) {
    points[a.date.slice(0, 7)] = round2(a.balance);
  }
  if (!txs.length) return points;

  // Layer 2 — roll the latest anchor through the ledger across the full
  // span of what we know about: all transactions plus the anchor itself.
  const anchor = ordered[ordered.length - 1];
  const windowStart = txs[0].date;
  const windowEnd = txs[txs.length - 1].date;
  const spanStart = anchor.date < windowStart ? anchor.date : windowStart;
  const coverageEnd = anchor.date > windowEnd ? anchor.date : windowEnd;

  // cumulative[i] = Σ signed(txs[0..i]); cumAt(E) = Σ for date ≤ E.
  const cumulative = [];
  let running = 0;
  for (const t of txs) {
    running += signedFor(t, catTypes);
    cumulative.push(running);
  }
  const cumAt = (isoDate) => {
    // Rightmost tx with date ≤ isoDate (ISO strings compare correctly).
    let lo = 0, hi = txs.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (txs[mid].date <= isoDate) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans === -1 ? 0 : cumulative[ans];
  };

  const atAnchor = cumAt(anchor.date);
  const rolled = {};
  for (const monthKey of monthKeysBetween(spanStart, coverageEnd)) {
    const lastCoveredDay = monthEnd(monthKey) < coverageEnd ? monthEnd(monthKey) : coverageEnd;
    rolled[monthKey] = round2(anchor.balance + cumAt(lastCoveredDay) - atAnchor);
  }
  return { ...points, ...rolled };
}

/**
 * Derived month-end values per Balance Sheet column:
 * { colKey: { 'YYYY-MM': value } }. When several accounts feed one column the
 * column derives only for months EVERY linked account covers — a partial sum
 * would silently understate the column, which is worse than showing nothing.
 */
function deriveColumnMonthEnds(db) {
  const linked = db
    .prepare('SELECT * FROM accounts WHERE balance_column IS NOT NULL')
    .all();
  if (!linked.length) return {};

  const catTypes = new Map(
    db.prepare('SELECT id, cat_type FROM categories').all().map((c) => [c.id, c.cat_type])
  );
  const txStmt = db.prepare(
    'SELECT date, amount, tx_type, category_id FROM transactions WHERE account_id = ? ORDER BY date, id'
  );
  const anchorStmt = db.prepare(
    'SELECT date, balance, source FROM account_balance_anchors WHERE account_id = ?'
  );

  // Group per-account results by column; null means "this account has no
  // observations at all", which vetoes its whole column (see the
  // all-accounts rule above).
  const perColumn = new Map();
  for (const account of linked) {
    const derived = deriveAccountMonthEnds(txStmt.all(account.id), anchorStmt.all(account.id), catTypes);
    const bucket = perColumn.get(account.balance_column) ?? [];
    bucket.push(derived);
    perColumn.set(account.balance_column, bucket);
  }

  const byColumn = {};
  for (const [colKey, results] of perColumn) {
    if (results.some((r) => r === null)) continue;
    // Months covered by every account of the column.
    let keys = Object.keys(results[0]);
    for (const r of results.slice(1)) keys = keys.filter((k) => k in r);
    if (!keys.length) continue;
    const months = {};
    for (const k of keys) {
      months[k] = round2(results.reduce((sum, r) => sum + r[k], 0));
    }
    byColumn[colKey] = months;
  }
  return byColumn;
}

// ─── Per-(year, column) sync — the Balance Sheet twin of category_sync ──────
// A row in balance_sync means that column's cells for that year are computed
// from its linked accounts' ledger + anchors (read-only in the UI, manual
// writes 409) instead of hand-entered. Columns default INTO sync when they
// first gain a linked account and when new years appear, mirroring Cash
// Flow's sync-by-default; the user opts cells OUT per year from the table's
// ⋮ → Sync Settings modal.

/** All synced cells as { yearStr: Set<colKey> }. */
function syncedBalanceMap(db) {
  const map = {};
  for (const r of db.prepare('SELECT year, category FROM balance_sync').all()) {
    (map[String(r.year)] ??= new Set()).add(r.category);
  }
  return map;
}

/** Column keys that have at least one linked account — the only columns that
 *  can meaningfully sync (an unlinked column has no data source). */
function linkedColumnKeys(db) {
  return new Set(
    db
      .prepare(
        'SELECT DISTINCT balance_column AS k FROM accounts WHERE balance_column IS NOT NULL'
      )
      .all()
      .map((r) => r.k)
  );
}

/** Ensure a Balance Sheet year tab exists; a NEWLY created one starts with
 *  every linked column synced (sync-by-default, opt-outs preserved because
 *  the seeding only fires on the year INSERT). Safe inside a transaction. */
function ensureBalanceYear(db, year) {
  const info = db
    .prepare('INSERT OR IGNORE INTO balance_active_years (year) VALUES (?)')
    .run(year);
  if (info.changes > 0) {
    db.prepare(
      `INSERT OR IGNORE INTO balance_sync (year, category)
       SELECT ?, balance_column FROM accounts WHERE balance_column IS NOT NULL`
    ).run(year);
  }
}

/** When a column gains its FIRST linked account, default it into sync for
 *  every existing year. Later links never re-seed, so a user's opt-outs are
 *  not resurrected by adding a second account to the same column. */
function seedNewlyLinkedColumn(db, colKey) {
  db.prepare(
    `INSERT OR IGNORE INTO balance_sync (year, category)
     SELECT year, ? FROM balance_active_years`
  ).run(colKey);
}

/**
 * The Balance Sheet data-payload hook (yearTableRoutes' augmentData). Synced
 * cells IGNORE stored manual values and carry the derived value for every
 * month the derivation knows (others stay empty → read-only "—"); unsynced
 * columns are purely hand-entered. Ships the per-year `sync` map (same shape
 * as Cash Flow's) plus `syncable` — the linked columns the Sync Settings
 * modal may offer to turn on.
 */
function overlayBalanceData(ctx, payload) {
  const db = ctx.db();
  const synced = syncedBalanceMap(db);
  const activeYears = new Set(payload.years.map(String));

  // Stored manual values in synced cells are ignored, not shown. (They stay
  // in balance_entries, so opting back out of sync restores them.)
  for (const [yearStr, months] of Object.entries(payload.entries)) {
    const set = synced[yearStr];
    if (!set) continue;
    for (const cells of Object.values(months)) {
      for (const key of set) delete cells[key];
    }
  }

  const byColumn = deriveColumnMonthEnds(db);
  for (const [colKey, months] of Object.entries(byColumn)) {
    for (const [monthKey, value] of Object.entries(months)) {
      const year = monthKey.slice(0, 4);
      if (!activeYears.has(year) || !synced[year]?.has(colKey)) continue;
      const month = VALID_MONTHS[Number(monthKey.slice(5, 7)) - 1];
      ((payload.entries[year] ??= {})[month] ??= {})[colKey] = value;
    }
  }

  const syncPayload = {};
  for (const [yearStr, set] of Object.entries(synced)) syncPayload[yearStr] = [...set];
  payload.sync = syncPayload;
  payload.syncable = [...linkedColumnKeys(db)];
  return payload;
}

module.exports = {
  deriveAccountMonthEnds,
  deriveColumnMonthEnds,
  overlayBalanceData,
  syncedBalanceMap,
  linkedColumnKeys,
  ensureBalanceYear,
  seedNewlyLinkedColumn,
};
