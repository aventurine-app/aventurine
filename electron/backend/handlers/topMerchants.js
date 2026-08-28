'use strict';

// Top Merchants (Reports → Spending) blueprint. Read-only: ranks the merchants
// the user spent the most with over a trailing window, for the bar chart that
// sits under Spending Trends. Trends breaks spending down by category, month by
// month; this breaks the same ledger down by merchant, totalled.
//
// WHAT COUNTS AS SPENDING matches the sibling report (see handlers/trends.js):
// a categorized row whose CATEGORY is an expense, plus an uncategorized row
// whose own tx_type is expense. Transfers and income are excluded, per the
// direction rule — money moved between the user's own accounts is not spending.
//
// MERCHANT GROUPING is services/merchantKey.js — the two-tier rule (curated
// display_name, else the leading content tokens of the normalised description)
// that used to live in this file. It moved when the Investing report needed the
// same grouping; the reasoning for each part is documented there. A row matching
// no merchant gets a null key and is skipped here, since a bar has to be
// labelled.
//
// THE WINDOW is a count of CALENDAR MONTHS ending with the current, partial one.
// Trends excludes the running month because a half-finished month distorts a
// per-month trend line; a ranking has no per-month shape, and excluding
// everything since the 1st would leave recent spending out of a "lately"
// ranking. 'all' drops the date filter entirely.

const { merchantKey, resolvedName } = require('../services/merchantKey');
const { commonSearchTerm } = require('../services/merchantSearch');
const { addMonthKey } = require('../services/forecast');
const { round2 } = require('../validate');

// Allowed trailing windows, in months, plus the un-windowed 'all'.
const ALLOWED_WINDOWS = new Set([3, 6, 12]);
const DEFAULT_WINDOW = 12;

// How many bars the chart draws. Fixed rather than a query param: the report is
// "top merchants", and a list long enough to scroll past is a table's job.
const TOP_N = 20;

/** Current local 'YYYY-MM'. */
function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function topMerchantsGet(ctx, { query }) {
  const db = ctx.db();

  const raw = String(query.window == null ? '' : query.window).trim().toLowerCase();
  let window;
  if (raw === 'all') {
    window = 'all';
  } else {
    const n = parseInt(raw, 10);
    window = ALLOWED_WINDOWS.has(n) ? n : DEFAULT_WINDOW;
  }
  // First month included: `window` months ending with the current one.
  const from = window === 'all' ? null : addMonthKey(currentMonthKey(), -(window - 1));

  // A categorized row takes its direction from its category (the direction rule
  // — a stored tx_type can lag a category re-type), an uncategorized row from
  // its own tx_type. Deleting a category requires its transactions be moved off
  // it first, so the LEFT JOIN always matches on a categorized row.
  const rows = db
    .prepare(
      `SELECT t.description AS description, t.display_name AS display_name,
              t.amount AS amount, t.date AS date
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE (CASE WHEN t.category_id IS NULL THEN t.tx_type ELSE c.cat_type END) = 'expense'
          ${from ? 'AND substr(t.date, 1, 7) >= ?' : ''}
        ORDER BY t.date`
    )
    .all(...(from ? [from] : []));

  const groups = new Map(); // key -> { key, named, name, total, count, last_date }
  for (const r of rows) {
    const key = merchantKey(r);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { key, named: key.startsWith('n:'), name: '', total: 0, count: 0, last_date: null };
      groups.set(key, g);
    }
    g.total += Number(r.amount) || 0;
    g.count += 1;
    // Rows arrive date-ordered, so the newest label is kept — for an unnamed
    // group that is the most recent raw description, the same row the ledger
    // shows at the top of the merchant's history.
    g.name = resolvedName(r) || String(r.description || '').trim();
    g.last_date = r.date;
  }

  // Name is the tiebreak so an equal-spend pair does not swap places between
  // two identical requests.
  const ranked = [...groups.values()]
    .filter((g) => g.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .slice(0, TOP_N);

  // Ledger search terms, for the ONLY groups that end up on screen — the
  // common-substring walk is quadratic in description length, and a ledger can
  // hold thousands of merchants the chart will never draw. A named group needs
  // no walk at all: the ledger's Name filter matches display_name too, so the
  // curated name finds exactly the rows this bar was built from.
  const wanted = new Map(ranked.filter((g) => !g.named).map((g) => [g.key, []]));
  if (wanted.size) {
    for (const r of rows) {
      const bucket = wanted.get(merchantKey(r));
      if (bucket) bucket.push(r.description);
    }
  }

  const merchants = ranked.map((g) => ({
    key: g.key,
    name: g.name,
    total: round2(g.total),
    count: g.count,
    last_date: g.last_date,
    search: g.named ? g.name : commonSearchTerm(wanted.get(g.key) || []),
  }));

  return { ok: true, window, from, limit: TOP_N, merchants };
}

const routes = [['GET', '/api/top-merchants', topMerchantsGet]];

module.exports = { routes };
