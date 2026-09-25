'use strict';

// services/statement.js: the Cash Flow cells every income/spend report reads.
// computedCells sums in SQL; these tests pin it to the plain per-row fold it
// replaced, on a randomized ledger that exercises every bucketing rule.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connect } = require('../db');
const { bootstrapSchema } = require('../migrate');
const { seedDefaults } = require('../seed');
const { VALID_MONTHS } = require('../validate');
const { computedCells, statementCells } = require('../services/statement');

function freshDb() {
  const db = connect(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-stmt-')), 's.db'));
  bootstrapSchema(db);
  seedDefaults(db);
  return db;
}

/** The per-row fold computedCells used before it summed in SQL: walk every
 *  transaction, key it, add it to its cell. Kept here as the reference. */
function referenceCells(db) {
  const active = new Set(db.prepare('SELECT year FROM active_years').all().map((y) => String(y.year)));
  const keyById = new Map(db.prepare('SELECT id, "key" FROM categories').all().map((c) => [c.id, c.key]));
  const sums = {};
  for (const t of db.prepare('SELECT date, amount, category_id, tx_type FROM transactions').all()) {
    if (!t.date || !active.has(t.date.slice(0, 4))) continue;
    let key;
    if (t.category_id == null) {
      if (t.tx_type === 'transfer') continue;
      key = t.tx_type === 'income' ? 'uncat_income' : 'uncat_expense';
    } else {
      key = keyById.get(t.category_id);
    }
    if (!key) continue;
    const month = VALID_MONTHS[parseInt(t.date.slice(5, 7), 10) - 1];
    const cells = ((sums[t.date.slice(0, 4)] ??= {})[month] ??= {});
    cells[key] = (cells[key] || 0) + t.amount;
  }
  return sums;
}

test('computedCells matches the per-row fold on a randomized ledger', () => {
  const db = freshDb();
  const cats = db.prepare('SELECT id, cat_type FROM categories').all();
  const ins = db.prepare(
    'INSERT INTO transactions (date, description, category_id, tx_type, amount) VALUES (?, ?, ?, ?, ?)'
  );
  let seed = 42;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  db.transaction(() => {
    for (let i = 0; i < 3000; i++) {
      const y = 2021 + Math.floor(rnd() * 5);
      const m = String(1 + Math.floor(rnd() * 12)).padStart(2, '0');
      const date = rnd() < 0.01 ? '' : `${y}-${m}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`;
      const r = rnd();
      // ~60% categorized (tx_type mirrors the category, as every write keeps
      // it), ~35% uncategorized in each direction, ~5% an orphaned category id.
      if (r < 0.6) {
        const c = pick(cats);
        ins.run(date, `row ${i}`, c.id, c.cat_type, Math.round(rnd() * 50000) / 100);
      } else if (r < 0.95) {
        ins.run(date, `row ${i}`, null, pick(['income', 'expense', 'transfer']), Math.round(rnd() * 50000) / 100);
      } else {
        ins.run(date, `row ${i}`, 99999, 'expense', Math.round(rnd() * 50000) / 100);
      }
    }
  })();
  // 2025 stays inactive: its rows must feed nothing.
  for (const y of [2021, 2022, 2023, 2024]) db.prepare('INSERT INTO active_years (year) VALUES (?)').run(y);

  const got = computedCells(db);
  const want = referenceCells(db);

  assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(want).sort());
  assert.ok(!('2025' in got), 'an inactive year contributes nothing');
  let cellCount = 0;
  for (const [year, months] of Object.entries(want)) {
    assert.deepStrictEqual(Object.keys(got[year]).sort(), Object.keys(months).sort(), year);
    for (const [month, cells] of Object.entries(months)) {
      assert.deepStrictEqual(Object.keys(got[year][month]).sort(), Object.keys(cells).sort(), `${year} ${month}`);
      for (const [key, value] of Object.entries(cells)) {
        // SQLite adds in its own order (and compensates for rounding error),
        // so the last bits may differ; a cent-scale figure must not.
        assert.ok(Math.abs(got[year][month][key] - value) < 1e-6, `${year} ${month} ${key}: ${got[year][month][key]} vs ${value}`);
        cellCount++;
      }
    }
  }
  assert.ok(cellCount > 500, 'the ledger exercises many cells');
});

test('computedCells reads the covering index instead of sorting the ledger', () => {
  const db = freshDb();
  db.prepare('INSERT INTO active_years (year) VALUES (2024)').run();
  // Capture the grouping query as computedCells prepares it, then ask SQLite
  // how it would run it. A GROUP BY that drifts from ix_transactions_month_cat
  // (a CASE in it, a filter on `date`) shows up as a temp B-tree sort.
  const seen = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => { seen.push(sql); return prepare(sql); };
  computedCells(db);
  db.prepare = prepare;

  const sql = seen.find((s) => /FROM transactions/.test(s) && /GROUP BY/.test(s));
  assert.ok(sql, 'computedCells groups transactions in SQL');
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join('\n');
  assert.match(plan, /USING COVERING INDEX ix_transactions_month_cat/, plan);
  assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
});

test('statementCells lets a stored entry override its one cell', () => {
  const db = freshDb();
  const rent = db.prepare("SELECT id FROM categories WHERE \"key\" = 'rent'").get().id;
  const ins = db.prepare(
    "INSERT INTO transactions (date, description, category_id, tx_type, amount) VALUES (?, 'x', ?, 'expense', ?)"
  );
  ins.run('2024-03-01', rent, 1000);
  ins.run('2024-04-01', rent, 1100);
  db.prepare('INSERT INTO active_years (year) VALUES (2024)').run();
  db.prepare("INSERT INTO entries (year, month, category, value) VALUES (2024, 3, 'rent', 950)").run();

  const cells = statementCells(db);
  assert.equal(cells['2024'].March.rent, 950);
  assert.equal(cells['2024'].April.rent, 1100);
});
