'use strict';

// Saved & Invested (Reports → Saved & Invested) blueprint. Read-only: how much
// moved into the user's savings and brokerage accounts each month over a
// trailing window, and which merchants it moved to. Both charts come from one
// payload so their totals cannot differ.
//
// WHAT COUNTS IS THE TRANSFER DIRECTION, not a category. This report first read
// the seeded `investing` category alone (the key handlers/reportCard.js grades
// the Metrics tab's invested share against), which was wrong in practice: the
// import lexicon decides which rows land in that category, so it matched
// Robinhood and missed Coinbase, with no indication in the UI. Fixing it that
// way would have required the user to hand-curate a category layer on top of the
// one the ledger already derives.
//
// The transfer DIRECTION is that already-derived layer. A categorized row's
// direction comes from its category's cat_type and an uncategorized row's from
// its own tx_type (the direction rule), the same rule the sibling reports use
// for spending — see handlers/topMerchants.js. A user who adds a "Brokerage"
// category, renames the seeded ones, or keeps five of them is counted with no
// extra bookkeeping; the only input required is the category's direction, which
// is already required.
//
// THE COST OF THAT, accepted and shared with the Metrics tab: a transfer is
// money MOVED, and the schema has no from/to pair (the v7 accounts work was
// reverted), so a withdrawal out of savings counts here the same as a deposit
// into it. Metrics reports this bucket the same way — its "Saved & Invested"
// figure and its savings rate are the same sum — so the two reports match, which
// matters more than a precision neither can produce. The per-merchant breakdown
// makes the direction readable: a column labelled Vanguard shows where the money
// went.
//
// THE WINDOW is a count of trailing COMPLETE months, ending with last month —
// the Spending Trends rule (handlers/trends.js), not the Top Merchants one. Both
// charts here are per-month shapes over time, and a half-finished month would
// render as a month with reduced saving.
//
// It is also clamped at the near end of the LEDGER: a month with no transactions
// of any kind was never imported, and drawing it as a zero would show no saving
// for a month with no data. Same rule as the Forecast's activeMonths and its
// history stopping at the first transaction. The clamp is the ledger's first
// row, not the first TRANSFER row — a user with five years of checking who
// started saving six months ago did save nothing in the eighteen months before
// that, so those zeroes are correct. The clamp removes only months with no data
// at all. `months` therefore reports what the chart can plot, and the renderer
// draws that rather than the requested count.
//
// MERCHANT GROUPING comes from services/merchantKey.js, shared with Top
// Merchants so the two reports group identically. A row matching no merchant is
// not dropped here the way it is there: it lands in the OTHER slice, because the
// stack has to total exactly what the line above it plots. A stack summing to
// less than the line above it would contradict the chart.

const { merchantKey, resolvedName } = require('../services/merchantKey');
const { commonSearchTerm } = require('../services/merchantSearch');
const { addMonthKey } = require('../services/forecast');
const { round2 } = require('../validate');

// Allowed trailing windows, in months.
const ALLOWED_WINDOWS = new Set([3, 6, 12, 24]);
const DEFAULT_WINDOW = 12;

// The direction rule as a SQL predicate: a categorized row takes its direction
// from its category (a stored tx_type can lag a category re-type), an
// uncategorized row from its own tx_type. Identical in shape to the predicate
// handlers/topMerchants.js uses for spending, so the two reports read the ledger
// the same way at different directions. Deleting a category requires its
// transactions be moved off it first, so the LEFT JOIN always matches on a
// categorized row.
const DIRECTION = "(CASE WHEN t.category_id IS NULL THEN t.tx_type ELSE c.cat_type END) = 'transfer'";

// How many merchants get a distinct colour in the stack. Eight is the
// categorical palette's full length (--cat-1..8, see static/css/style.css): a
// ninth series would need a generated or reused hue, which is indistinguishable
// under colour-vision deficiency and would make the legend inaccurate.
// Everything past the eighth folds into one neutral OTHER slice.
const TOP_N = 8;

// The key of that slice. Prefixed like the real ones ('n:' / 'd:') so it cannot
// collide with a merchant named "other".
const OTHER_KEY = '__other__';

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
  // the near end forward to wherever the ledger actually starts.
  const lastComplete = addMonthKey(currentMonthKey(), -1);
  const desiredStart = addMonthKey(lastComplete, -(window - 1));
  const ledgerStart = db.prepare('SELECT MIN(substr(date, 1, 7)) AS ym FROM transactions').get().ym;
  // 'YYYY-MM' sorts lexicographically in chronological order, so a plain compare
  // is the month compare.
  const firstMonth = ledgerStart && ledgerStart > desiredStart ? ledgerStart : desiredStart;
  const months = [];
  for (let m = firstMonth; m <= lastComplete; m = addMonthKey(m, 1)) months.push(m);

  const rows = db
    .prepare(
      `SELECT t.description AS description, t.display_name AS display_name,
              t.amount AS amount, substr(t.date, 1, 7) AS ym
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE ${DIRECTION}
          AND substr(t.date, 1, 7) BETWEEN ? AND ?
        ORDER BY t.date`
    )
    .all(firstMonth, lastComplete);

  // Per-month totals for the line chart. Built from the same rows the stack is
  // built from rather than by a second SUM() query, so the two can't drift.
  const monthly = {};
  let total = 0;
  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    monthly[r.ym] = (monthly[r.ym] || 0) + amt;
    total += amt;
  }
  for (const ym of Object.keys(monthly)) monthly[ym] = round2(monthly[ym]);

  // Per-merchant, per-month sums. Rows arrive date-ordered, so an unnamed group
  // keeps the newest label — the most recent raw description, the same row the
  // ledger shows at the top of that merchant's history.
  const groups = new Map(); // key -> { key, named, name, total, count, monthly }
  const unknown = [];       // rows matching no merchant, held for the OTHER slice
  for (const r of rows) {
    const key = merchantKey(r);
    if (!key) { unknown.push(r); continue; }
    let g = groups.get(key);
    if (!g) {
      g = { key, named: key.startsWith('n:'), name: '', total: 0, count: 0, monthly: {} };
      groups.set(key, g);
    }
    const amt = Number(r.amount) || 0;
    g.total += amt;
    g.count += 1;
    g.monthly[r.ym] = (g.monthly[r.ym] || 0) + amt;
    g.name = resolvedName(r) || String(r.description || '').trim();
  }

  // Name is the tiebreak so an equal-value pair doesn't swap places between two
  // identical requests (and therefore doesn't swap colours in the legend).
  const ranked = [...groups.values()]
    .filter((g) => g.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const top = ranked.slice(0, TOP_N);
  const tail = ranked.slice(TOP_N);

  // Ledger search terms, for the groups that end up on screen only — the
  // common-substring walk is quadratic in description length. A named group
  // needs no walk: the ledger's Name filter matches display_name too, so the
  // curated name finds exactly the rows this slice was built from.
  const wanted = new Map(top.filter((g) => !g.named).map((g) => [g.key, []]));
  if (wanted.size) {
    for (const r of rows) {
      const bucket = wanted.get(merchantKey(r));
      if (bucket) bucket.push(r.description);
    }
  }

  const merchants = top.map((g) => ({
    key: g.key,
    name: g.name,
    total: round2(g.total),
    count: g.count,
    monthly: Object.fromEntries(Object.entries(g.monthly).map(([ym, v]) => [ym, round2(v)])),
    search: g.named ? g.name : commonSearchTerm(wanted.get(g.key) || []),
  }));

  // OTHER: the ranked tail plus every row that named nobody. Built last so the
  // stack totals the line exactly. It carries no `search` — it is not one group
  // of transactions, so there is no filter that would show it in the ledger.
  const otherMonthly = {};
  let otherTotal = 0;
  let otherCount = 0;
  for (const g of tail) {
    for (const [ym, v] of Object.entries(g.monthly)) {
      otherMonthly[ym] = (otherMonthly[ym] || 0) + v;
    }
    otherTotal += g.total;
    otherCount += g.count;
  }
  for (const r of unknown) {
    const amt = Number(r.amount) || 0;
    otherMonthly[r.ym] = (otherMonthly[r.ym] || 0) + amt;
    otherTotal += amt;
    otherCount += 1;
  }

  if (otherTotal > 0) {
    merchants.push({
      key: OTHER_KEY,
      name: 'Other',
      total: round2(otherTotal),
      count: otherCount,
      monthly: Object.fromEntries(Object.entries(otherMonthly).map(([ym, v]) => [ym, round2(v)])),
      search: null,
    });
  }

  // Whether the ledger holds ANY transfer at all, window aside. Without it the
  // renderer cannot separate "no transfers ever" from "none in this window", and
  // those two empty states show different text: the first offers a way to start,
  // the second suggests a longer time frame. One EXISTS query rather than a
  // second aggregate, since the result is a boolean.
  const everTransferred = !!db
    .prepare(
      `SELECT 1 FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE ${DIRECTION} LIMIT 1`
    )
    .get();

  return { ok: true, window, months, total: round2(total), monthly, merchants, everTransferred };
}

const routes = [['GET', '/api/transfers', transfersGet]];

module.exports = { routes };
