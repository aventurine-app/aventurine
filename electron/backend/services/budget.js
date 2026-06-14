'use strict';

// Budget Buckets (Account Tracking) — pure composition for the budget-vs-actual
// view. No DB handle: the handler gathers targets + transaction actuals and this
// assembles the response. Money is rounded at the boundary via round2.

const { round2, VALID_MONTHS } = require('../validate');

// Category types that get a budget envelope. Income isn't budgeted — it's the
// month's inflow that drives "left to budget".
const BUDGETABLE = new Set(['expense', 'savings', 'investing']);

// The seeded system buckets for uncategorized rows aren't real envelopes.
const SYSTEM_KEYS = new Set(['uncat_income', 'uncat_expense']);

/** True when a category row should get a budget envelope. */
function isBudgetable(cat) {
  return BUDGETABLE.has(cat.cat_type) && !SYSTEM_KEYS.has(cat.key);
}

/** The 'YYYY-MM' prefix for a (year, monthName) pair, or null if the month name
 *  is invalid. Transaction dates are 'YYYY-MM-DD' strings, so a prefix match on
 *  substr(date,1,7) selects a calendar month. */
function monthPrefix(year, monthName) {
  const idx = VALID_MONTHS.indexOf(monthName);
  if (idx === -1) return null;
  return `${year}-${String(idx + 1).padStart(2, '0')}`;
}

/**
 * Assemble the budget view. Inputs:
 *   categories     — all category rows (id/key/name/cat_type/position), pre-sorted.
 *   targets        — Map<categoryKey, amount> for the month.
 *   actualByKey    — Map<categoryKey, spentAmount> for the month (categorized rows).
 *   expectedIncome — the month's planned income ("left to budget" is measured against
 *                    this, so the figure is meaningful from day 1, not only once
 *                    paychecks land).
 *   incomeSource   — 'average' (auto from history) | 'override' (user-set).
 *   received       — income actually received so far this month (shown alongside).
 * Returns { categories: [{key,name,cat_type,target,spent,remaining}], summary }.
 */
function buildBudget({ categories, targets, actualByKey, expectedIncome, incomeSource, received }) {
  const rows = [];
  let budgeted = 0;
  let spent = 0;

  for (const cat of categories) {
    if (!isBudgetable(cat)) continue;
    const target = round2(targets.get(cat.key) || 0);
    const catSpent = round2(actualByKey.get(cat.key) || 0);
    budgeted += target;
    spent += catSpent;
    rows.push({
      key: cat.key,
      name: cat.name,
      cat_type: cat.cat_type,
      target,
      spent: catSpent,
      remaining: round2(target - catSpent),
    });
  }

  budgeted = round2(budgeted);
  spent = round2(spent);
  const expected = round2(expectedIncome || 0);

  return {
    categories: rows,
    summary: {
      expectedIncome: expected,
      incomeSource,
      received: round2(received || 0),
      budgeted,
      leftToBudget: round2(expected - budgeted),
      spent,
      remaining: round2(budgeted - spent),
    },
  };
}

module.exports = { BUDGETABLE, isBudgetable, monthPrefix, buildBudget };
