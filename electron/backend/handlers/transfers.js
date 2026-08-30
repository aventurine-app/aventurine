'use strict';

// Saved & Invested (Reports → Saved & Invested) blueprint. Read-only: how much
// moved into the user's savings and brokerage accounts each month over a
// trailing window, and which account it moved into. Both charts come from one
// payload so their totals cannot differ.
//
// WHAT COUNTS IS THE TRANSFER DIRECTION, not a curated category. This report
// first read the seeded `investing` category alone (the key
// handlers/reportCard.js grades the Metrics tab's invested share against), which
// was wrong in practice: the import lexicon decides which rows land in that
// category, so it matched Robinhood and missed Coinbase, with no indication in
// the UI. Fixing it that way would have required the user to hand-curate a
// category layer on top of the one the ledger already derives.
//
// The transfer DIRECTION is that already-derived layer. A categorized row's
// direction comes from its category's cat_type and an uncategorized row's from
// its own tx_type (the direction rule). A user who adds a "Brokerage" category,
// renames the seeded ones, or keeps five of them is counted with no extra
// bookkeeping; the only input required is the category's direction, which is
// already required.
//
// THE COST OF THAT, accepted and shared with the Metrics tab: a transfer is
// money MOVED, and the schema has no from/to pair (the v7 accounts work was
// reverted), so a withdrawal out of savings counts here the same as a deposit
// into it. Metrics reports this bucket the same way — its "Saved & Invested"
// figure and its savings rate are the same sum — so the two reports match, which
// matters more than a precision neither can produce.
//
// SOURCE OF TRUTH IS THE CASH FLOW STATEMENT, not the raw ledger — the switch
// handlers/trends.js made. A transfer category's month IS a statement cell, so
// a hand-typed cell is what this report plots, and a year with no year-table is
// off this report exactly as it is off the statement.
//
// BOTH CHARTS READ THE SAME CELLS. The breakdown is by ACCOUNT — one band per
// Transfer row of the Cash Flow grid (Savings, Investing, and whatever the user
// added) — so the stack is the statement's own itemisation of the line above it
// and the two agree by construction, typed cells included. It was by MERCHANT
// before, grouped out of the raw descriptions, which could only ever total the
// line while every cell was computed: a typed cell asserts a number the ledger
// does not itemise, so the merchant reading had to abstain and dump it in a
// grey "Other" band. Reading the statement's own rows removes the question.
//
// AN UNCATEGORIZED TRANSFER gets a band of its own. It is money the direction
// rule counts in the line, but the statement gives it no row (see txKey in
// handlers/incomeExpenses.js — it is neither income nor spending, and there is
// no uncat_transfer bucket), so the ledger is the only thing that speaks for it
// and it is summed directly. It carries no ledger link: `?cat=` addresses a
// category, and "uncategorized AND moved" is not one the filter can express, so
// it goes unlinked rather than linked to something broader than the band.
//
// THE WINDOW is a count of trailing COMPLETE months, ending with last month —
// the Spending Trends rule (handlers/trends.js), not the Top Merchants one. Both
// charts here are per-month shapes over time, and a half-finished month would
// render as a month with reduced saving.
//
// It is also clamped at the near end of COVERAGE: a month with nothing behind it
// was never imported, and drawing it as a zero would show no saving for a month
// with no data. Same rule as the Forecast's activeMonths and its history
// stopping at the first transaction. The clamp is the earlier of the ledger's
// first row and the first typed transfer cell — a typed cell is the user saying
// what a month held, which is coverage too — and it is NOT the first TRANSFER
// row: a user with five years of checking who started saving six months ago did
// save nothing in the eighteen months before that, so those zeroes are correct.
// `months` therefore reports what the chart can plot, and the renderer draws
// that rather than the requested count.

const { addMonthKey } = require('../services/forecast');
const { computedCells, manualCells, blendCells } = require('./incomeExpenses');
const { round2, monthName } = require('../validate');

// Allowed trailing windows, in months.
const ALLOWED_WINDOWS = new Set([3, 6, 12, 24]);
const DEFAULT_WINDOW = 12;

// The direction rule as a SQL predicate, for the two questions the statement
// cannot answer: whether the ledger has EVER held a transfer, and what the
// uncategorized ones sum to. A categorized row takes its direction from its
// category (a stored tx_type can lag a category re-type), an uncategorized row
// from its own tx_type. Deleting a category requires its transactions be moved
// off it first, so the LEFT JOIN always matches on a categorized row.
const DIRECTION = "(CASE WHEN t.category_id IS NULL THEN t.tx_type ELSE c.cat_type END) = 'transfer'";

// How many accounts get a distinct colour in the stack. Eight is the categorical
// palette's full length (--cat-1..8, see static/css/style.css): a ninth series
// would need a generated or reused hue, which is indistinguishable under
// colour-vision deficiency and would make the legend inaccurate. Everything past
// the eighth folds into one neutral OTHER slice.
const TOP_N = 8;

// The key of that slice, and of the band the uncategorized transfers get.
// Prefixed so neither can collide with a category key.
const OTHER_KEY = '__other__';
const UNCAT_KEY = '__uncategorized__';

/** Current local 'YYYY-MM'. */
function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function transfersGet(ctx, { query }) {
  const db = ctx.db();

  let window = parseInt(query.window, 10);
  if (!ALLOWED_WINDOWS.has(window)) window = DEFAULT_WINDOW;

  // Trailing `window` COMPLETE months: end at last month, walk back, then pull
  // the near end forward to wherever coverage actually starts.
  const lastComplete = addMonthKey(currentMonthKey(), -1);
  const desiredStart = addMonthKey(lastComplete, -(window - 1));
  const ledgerStart = db.prepare('SELECT MIN(substr(date, 1, 7)) AS ym FROM transactions').get().ym;
  const entryStart = db
    .prepare(
      `SELECT MIN(printf('%04d-%02d', e.year, e.month)) AS ym
         FROM entries e JOIN categories c ON c."key" = e.category
        WHERE c.cat_type = 'transfer'`
    )
    .get().ym;
  // 'YYYY-MM' sorts lexicographically in chronological order, so a plain compare
  // is the month compare.
  const covered = [ledgerStart, entryStart].filter(Boolean).sort()[0];
  const firstMonth = covered && covered > desiredStart ? covered : desiredStart;

  // A year with no year-table is off the statement, so it is off this report
  // too — plotted as nothing rather than as a zero, which would claim the user
  // put nothing away in a year the statement never covered.
  const activeYears = new Set(
    db.prepare('SELECT year FROM active_years').all().map((y) => String(y.year))
  );
  const months = [];
  for (let m = firstMonth; m <= lastComplete; m = addMonthKey(m, 1)) {
    if (activeYears.has(m.slice(0, 4))) months.push(m);
  }
  const inWindow = new Set(months);

  // The statement, cell for cell: computed from transactions, a typed Entry
  // overriding its own cell.
  const cells = blendCells(computedCells(db), manualCells(db));
  const cellAt = (ym, key) =>
    cells[ym.slice(0, 4)]?.[monthName(Number(ym.slice(5, 7)))]?.[key];

  // One band per Transfer row of the grid, in the statement's own order (the
  // rank below re-sorts them; position is only the tiebreak that keeps an equal
  // pair from swapping colours between two identical requests).
  const bands = db
    .prepare("SELECT \"key\", name FROM categories WHERE cat_type = 'transfer' ORDER BY position")
    .all()
    .map((cat) => {
      const monthly = {};
      let total = 0;
      for (const ym of months) {
        const amt = Number(cellAt(ym, cat.key)) || 0;
        if (!amt) continue;
        monthly[ym] = round2(amt);
        total += amt;
      }
      // The ledger's Category filter takes the stable key, so a renamed account
      // keeps its link (see txApplyUrlFilters in static/js/pages/transactions.js).
      return { key: cat.key, name: cat.name, cat: cat.key, total: round2(total), monthly };
    });

  // The uncategorized band, straight from the ledger.
  const uncatMonthly = {};
  let uncatTotal = 0;
  for (const r of db
    .prepare(
      `SELECT substr(t.date, 1, 7) AS ym, SUM(t.amount) AS s
         FROM transactions t
        WHERE t.category_id IS NULL AND t.tx_type = 'transfer'
          AND substr(t.date, 1, 7) BETWEEN ? AND ?
        GROUP BY ym`
    )
    .all(firstMonth, lastComplete)) {
    if (!inWindow.has(r.ym)) continue;
    const amt = Number(r.s) || 0;
    if (!amt) continue;
    uncatMonthly[r.ym] = round2(amt);
    uncatTotal += amt;
  }
  if (uncatTotal > 0) {
    bands.push({
      key: UNCAT_KEY, name: 'Uncategorized', cat: null,
      total: round2(uncatTotal), monthly: uncatMonthly,
    });
  }

  // Name is the tiebreak so an equal-value pair doesn't swap places between two
  // identical requests (and therefore doesn't swap colours in the legend).
  const ranked = bands
    .filter((b) => b.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const accounts = ranked.slice(0, TOP_N);
  const tail = ranked.slice(TOP_N);

  // OTHER: the ranked tail. Built last so the stack totals the line exactly. It
  // carries no `cat` — it is not one account, so there is no filter that would
  // show it in the ledger.
  if (tail.length) {
    const otherMonthly = {};
    let otherTotal = 0;
    for (const b of tail) {
      for (const [ym, v] of Object.entries(b.monthly)) {
        otherMonthly[ym] = round2((otherMonthly[ym] || 0) + v);
      }
      otherTotal += b.total;
    }
    accounts.push({
      key: OTHER_KEY, name: 'Other', cat: null,
      total: round2(otherTotal), monthly: otherMonthly,
    });
  }

  // The line: the sum of the bands, so the stack cannot fail to total it.
  const monthly = {};
  let total = 0;
  for (const b of ranked) {
    for (const [ym, v] of Object.entries(b.monthly)) {
      monthly[ym] = (monthly[ym] || 0) + v;
      total += v;
    }
  }
  for (const ym of Object.keys(monthly)) monthly[ym] = round2(monthly[ym]);

  // Whether the ledger holds ANY transfer at all, window aside. Without it the
  // renderer cannot separate "no transfers ever" from "none in this window", and
  // those two empty states show different text: the first offers a way to start,
  // the second suggests a longer time frame. A typed cell counts as saving too,
  // so a user who records it by hand is never offered a first one. EXISTS
  // queries rather than aggregates, since the result is a boolean.
  const everTransferred =
    !!db
      .prepare(
        `SELECT 1 FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
          WHERE ${DIRECTION} LIMIT 1`
      )
      .get()
    || !!db
      .prepare(
        `SELECT 1 FROM entries e JOIN categories c ON c."key" = e.category
          WHERE c.cat_type = 'transfer' AND e.value != 0 LIMIT 1`
      )
      .get();

  return { ok: true, window, months, total: round2(total), monthly, accounts, everTransferred };
}

const routes = [['GET', '/api/transfers', transfersGet]];

module.exports = { routes };
