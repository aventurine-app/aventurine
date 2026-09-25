'use strict';

// The year-and-cell routes the two statements share. Cash Flow and the Balance
// Sheet are both a set of active years plus a table of hand-entered cells keyed
// (year, month, column key); this produces the five routes that manage them.
// What differs, and stays in each statement's own handler, is how the grid is
// read and what its columns are.
//
// Table names come from the callers' config, never from user input, so they are
// safe to interpolate into the SQL strings.

const { bad, parseEntry, validateYear, monthNumber } = require('../validate');

/**
 * @param {object} cfg
 * @param {string} cfg.prefix     route prefix ('/api' or '/api/balance')
 * @param {string} cfg.yearTable  the statement's active-years table
 * @param {string} cfg.entryTable its (year, month, category, value) cells
 * @param {string} cfg.keyTable   the table a cell's key must name on write
 */
function yearEntryRoutes({ prefix, yearTable, entryTable, keyTable }) {
  function upsertEntry(ctx, { body }) {
    const db = ctx.db();
    const parsed = parseEntry(body);
    // The key must name a column of THIS statement (a category for Cash Flow,
    // a balance column for the Balance Sheet), which parseEntry cannot check.
    //
    // WRITE ONLY. Reads and deletes stay unchecked on purpose: a database that
    // has climbed through v9/v11/v14, or that predates the removal of the budget
    // and credit-card features, can hold entry rows whose key no longer resolves.
    // Refusing to READ those would make historical cells disappear from the
    // statement, and refusing to DELETE them would leave the user no way to clear
    // one. This stops new orphans; it does not disown the old ones.
    if (!db.prepare(`SELECT 1 FROM ${keyTable} WHERE "key" = ?`).get(parsed.category)) {
      bad('unknown category');
    }
    db.prepare(
      `INSERT INTO ${entryTable} (year, month, category, value) VALUES (?, ?, ?, ?)
       ON CONFLICT(year, month, category) DO UPDATE SET value = excluded.value`
    ).run(parsed.year, monthNumber(parsed.month), parsed.category, parsed.value);
    return { ok: true };
  }

  function deleteEntry(ctx, { body }) {
    const db = ctx.db();
    const parsed = parseEntry(body, { requireValue: false });
    db.prepare(`DELETE FROM ${entryTable} WHERE year = ? AND month = ? AND category = ?`).run(
      parsed.year,
      monthNumber(parsed.month),
      parsed.category
    );
    return { ok: true };
  }

  function addYear(ctx, { body }) {
    const db = ctx.db();
    if (!body) bad('invalid request');
    const year = body.year;
    if (!validateYear(year)) bad('invalid year');
    db.prepare(`INSERT OR IGNORE INTO ${yearTable} (year) VALUES (?)`).run(year);
    return { ok: true, year };
  }

  function deleteYear(ctx, { params }) {
    const db = ctx.db();
    db.transaction(() => {
      db.prepare(`DELETE FROM ${yearTable} WHERE year = ?`).run(params.year);
      db.prepare(`DELETE FROM ${entryTable} WHERE year = ?`).run(params.year);
    })();
    return { ok: true };
  }

  /** Copy a year's hand-entered cells into a new year. Only stored entries are
   *  copied: Cash Flow's computed cells recompute from the target year's own
   *  transactions. */
  function duplicateYear(ctx, { params, body }) {
    const db = ctx.db();
    const target = (body || {}).target_year;
    if (!validateYear(target)) bad('invalid target_year');
    if (db.prepare(`SELECT 1 FROM ${yearTable} WHERE year = ?`).get(target)) {
      bad('year already exists');
    }
    db.transaction(() => {
      db.prepare(`INSERT INTO ${yearTable} (year) VALUES (?)`).run(target);
      db.prepare(
        `INSERT INTO ${entryTable} (year, month, category, value)
         SELECT ?, month, category, value FROM ${entryTable} WHERE year = ?`
      ).run(target, params.year);
    })();
    return { ok: true, year: target };
  }

  return [
    ['POST', `${prefix}/entry`, upsertEntry],
    ['DELETE', `${prefix}/entry`, deleteEntry],
    ['POST', `${prefix}/year`, addYear],
    ['DELETE', `${prefix}/year/<int:year>`, deleteYear],
    ['POST', `${prefix}/year/<int:year>/duplicate`, duplicateYear],
  ];
}

module.exports = { yearEntryRoutes };
