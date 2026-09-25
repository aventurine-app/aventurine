'use strict';

// Cash Flow (Income & Expenses) routes: the statement grid read. How its cells
// are computed and blended lives in services/statement.js; the year and cell
// write routes it shares with the Balance Sheet come from yearTable.js.

const { yearEntryRoutes } = require('./yearTable');
const { computedCells, manualCells, blendCells } = require('../services/statement');

function columnsPayload(db) {
  return db
    .prepare('SELECT "key", name, cat_type FROM categories ORDER BY position')
    .all()
    .map((c) => ({ key: c.key, label: c.name, type: c.cat_type }));
}

function dataGet(ctx) {
  const db = ctx.db();

  // Read once and use for both: the payload's `years` list and the year filter
  // computedCells applies.
  const years = db.prepare('SELECT year FROM active_years').all().map((y) => y.year);

  const computed = computedCells(db, new Set(years.map(String)));
  const manual = manualCells(db);

  // `entries` is the blended view (what every consumer renders); `computed`
  // and `manual` are the layers, shipped so the statement UI can style a
  // cell's provenance and show the computed shadow value under an override.
  return {
    years: years.sort((a, b) => a - b),
    entries: blendCells(computed, manual),
    computed,
    manual,
    columns: columnsPayload(db),
  };
}

const routes = [
  ['GET', '/api/data', dataGet],
  ...yearEntryRoutes({
    prefix: '/api',
    yearTable: 'active_years',
    entryTable: 'entries',
    keyTable: 'categories',
  }),
];

module.exports = { routes };
