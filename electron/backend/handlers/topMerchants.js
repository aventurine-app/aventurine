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
//
// NOTHING HERE ANSWERS "IS THIS RISING". Two fields used to: a per-merchant
// month series behind a 50px sparkline, and `prev` — the same merchant's total
// over the immediately prior window — behind a change pill. Both cells are gone
// from the card, so both are gone from here. The read is narrower for it: `prev`
// is why the query's lower bound was a window EARLIER than the window being
// ranked, so every request scanned twice the rows it reported on. Direction over
// time is the sibling report's question (handlers/trends.js), which has a chart
// for it rather than twenty marks in a margin.
//
// EACH BAR ALSO CARRIES A CATEGORY. `category` is the expense category the
// merchant spent the most in over the window, which the card draws the bar in —
// in the colour the Spending Trends rail above it gave that category, so one
// hue names one category across both cards of the tab. A merchant is not a
// category (a hardware store's rows sit in Home and in Automobile), so the bar
// takes the dominant one and the tie is broken on the key, keeping two
// identical requests the same colour. An uncategorized row answers to the
// synthetic key Trends ships for the statement's uncategorized bucket.
//
// `total` is every expense in the window, named or not, ranked or not. It is
// the denominator the card scales its bars against: a bar's length is its share
// of what was actually spent, not its share of rank 1.
//
// THE CATEGORY FILTER (`?category=<key>`) narrows the ranking to one expense
// category, which is what the Spending Trends rail beside it selects. It is a
// filter on the SAME ledger read, not a different source: the two cards of this
// tab still disagree wherever a statement cell was typed by hand (see
// handlers/trends.js), and narrowing one of them does not change that.
//
// THE EXCLUSIONS (`?exclude=<key>,<key>`) drop categories the Trends rail's
// swatches have switched off, so one card's legend governs both. They filter
// the RANKING and nothing else: the ledger read, `total`, every merchant's
// `total` and `count`, and the dominant `category` each bar is coloured from
// are all computed over the whole window first, and the excluded merchants are
// removed afterwards. A merchant's bar is therefore the same length whichever
// categories are switched off — its share is of what was spent, not of what is
// still listed — and hiding a category promotes the merchants below rank 20
// into the places it vacated. A merchant is dropped on its DOMINANT category
// (the one the bar is drawn in), so a hardware store whose rows sit in Home and
// in Automobile leaves with Home and keeps its whole total while it stays. An
// unknown key matches no merchant and so excludes nothing, unlike the 404 on
// `category`: filtering to a key that matches nothing yields a plausible-looking
// empty card, while excluding one is a no-op with nothing misleading to show.

const { merchantKey, resolvedName } = require('../services/merchantKey');
const { commonSearchTerm } = require('../services/merchantSearch');
const { addMonthKey } = require('../services/forecast');
const { round2, bad } = require('../validate');

// Allowed trailing windows, in months, plus the un-windowed 'all'.
const ALLOWED_WINDOWS = new Set([3, 6, 12, 24, 60]);
const DEFAULT_WINDOW = 12;

// How many bars the chart draws. Fixed rather than a query param: the report is
// "top merchants", and a list long enough to scroll past is a table's job.
const TOP_N = 20;

// The synthetic key Trends ships for the statement's uncategorized-expense
// bucket (see handlers/trends.js). It is the wire key the rail selects with, so
// this endpoint has to answer to the same string; the ledger side of it is
// simply "no category".
const UNCAT_KEY = '__uncategorized__';

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
  const thisMonth = currentMonthKey();
  // First month included: `window` months ending with the current one.
  const from = window === 'all' ? null : addMonthKey(thisMonth, -(window - 1));

  // A category key narrows the ranking to that category. An unknown key is a
  // 404 rather than an empty ranking: the only caller picks the key out of the
  // Trends payload, so a key that resolves to nothing is a bug on the way in,
  // and answering it with a plausible empty card would hide that.
  const catRaw = String(query.category == null ? '' : query.category).trim();
  let category = null;
  let catSql = '';
  const catParams = [];
  if (catRaw) {
    category = catRaw;
    if (catRaw === UNCAT_KEY) {
      catSql = 'AND t.category_id IS NULL';
    } else {
      const row = db.prepare('SELECT id FROM categories WHERE "key" = ?').get(catRaw);
      if (!row) throw bad('Unknown category', 404);
      catSql = 'AND t.category_id = ?';
      catParams.push(row.id);
    }
  }

  // The categories the rail has switched off. Comma-separated because the whole
  // set travels on every request — the rail's state, not a delta — and one key
  // per parameter would make an empty list and a missing one two shapes to read.
  // These stay out of the SQL: the figures are read over the whole window and
  // the ranking is filtered at the end, so nothing here narrows the ledger.
  const excludeRaw = String(query.exclude == null ? '' : query.exclude).trim();
  const exclude = [...new Set(excludeRaw.split(',').map((s) => s.trim()).filter(Boolean))];
  const excluded = new Set(exclude);

  // A categorized row takes its direction from its category (the direction rule
  // — a stored tx_type can lag a category re-type), an uncategorized row from
  // its own tx_type. Deleting a category requires its transactions be moved off
  // it first, so the LEFT JOIN always matches on a categorized row. The window
  // is the whole read now: with `prev` gone there is nothing to fetch from
  // before it.
  const rows = db
    .prepare(
      `SELECT t.description AS description, t.display_name AS display_name,
              t.amount AS amount, t.date AS date, c."key" AS cat_key
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE (CASE WHEN t.category_id IS NULL THEN t.tx_type ELSE c.cat_type END) = 'expense'
          ${from ? 'AND substr(t.date, 1, 7) >= ?' : ''}
          ${catSql}
        ORDER BY t.date`
    )
    .all(...(from ? [from] : []), ...catParams);

  const groups = new Map(); // key -> { key, named, name, total, count, last_date, cats }
  // Every expense in the window, whether or not it named a merchant. This is
  // the denominator the card states each bar's share against, and it has to
  // count the rows no bar was built from — the unidentifiable ones, everything
  // past rank 20, and everything in a switched-off category — or a "share of
  // spending" would be a share of the chart, which reads as a much bigger
  // number than it is, and would move every bar each time a swatch is clicked.
  let windowTotal = 0;
  for (const r of rows) {
    windowTotal += Number(r.amount) || 0;
    const key = merchantKey(r);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { key, named: key.startsWith('n:'), name: '', total: 0, count: 0, last_date: null, cats: new Map() };
      groups.set(key, g);
    }
    const amount = Number(r.amount) || 0;
    g.total += amount;
    g.count += 1;
    // Spend per category, for the ONE category the bar is drawn in. A merchant
    // is not a category — a hardware store's rows can sit in Home and in
    // Automobile — so the bar takes the category the merchant spent the most in
    // over the window, and the tie is broken on the key so two identical
    // requests colour the bar the same way. An uncategorized row answers to the
    // synthetic key Trends ships for the statement's uncategorized bucket, so
    // both cards of this tab colour it from the same entry in the ramp.
    const catKey = r.cat_key || UNCAT_KEY;
    g.cats.set(catKey, (g.cats.get(catKey) || 0) + amount);
    // Rows arrive date-ordered, so the newest label is kept — for an unnamed
    // group that is the most recent raw description, the same row the ledger
    // shows at the top of the merchant's history.
    g.name = resolvedName(r) || String(r.description || '').trim();
    g.last_date = r.date;
  }

  // The ONE category each bar is drawn in, resolved before the ranking because
  // the exclusions are read off it.
  const dominantCategory = (g) =>
    [...g.cats.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  for (const g of groups.values()) g.category = dominantCategory(g);

  // Name is the tiebreak so an equal-spend pair does not swap places between
  // two identical requests. The switched-off categories are dropped here, after
  // every figure is settled and before the cap, so the twenty places are filled
  // by whoever is left rather than left standing empty.
  const ranked = [...groups.values()]
    .filter((g) => g.total > 0 && !excluded.has(g.category))
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
    category: g.category,
    search: g.named ? g.name : commonSearchTerm(wanted.get(g.key) || []),
  }));

  return { ok: true, window, from, category, exclude, limit: TOP_N, total: round2(windowTotal), merchants };
}

const routes = [['GET', '/api/top-merchants', topMerchantsGet]];

module.exports = { routes };
