'use strict';

// Budget envelopes — pure composition for the budget-vs-actual view. No DB
// handle: the handler gathers the recurring targets + a month's transaction
// actuals and this assembles the response. Money is rounded at the boundary
// via round2.
//
// Targets are a single recurring figure per category (budget_amounts), applied
// to every month; only the actual spend is scoped to the month being viewed.

const { round2, VALID_MONTHS } = require('../validate');

// Category types that get a budget envelope. Income isn't budgeted — it's the
// month's inflow, surfaced only as a small reference figure.
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
 *   categories  — all category rows (id/key/name/cat_type/position), pre-sorted.
 *   targets     — Map<categoryKey, amount>: the recurring budget per category.
 *   actualByKey — Map<categoryKey, spentAmount> for the viewed month.
 *   received    — income actually received in the viewed month (shown as a small,
 *                 informational reference; the budget itself isn't income-based).
 * Returns { categories: [{key,name,cat_type,target,spent,remaining}], summary }.
 * A category with no recurring target has target 0; the UI hides those behind an
 * "add a budget" affordance rather than listing them as empty envelopes.
 */
function buildBudget({ categories, targets, actualByKey, received }) {
  const rows = [];

  for (const cat of categories) {
    if (!isBudgetable(cat)) continue;
    const target = round2(targets.get(cat.key) || 0);
    const catSpent = round2(actualByKey.get(cat.key) || 0);
    rows.push({
      key: cat.key,
      name: cat.name,
      cat_type: cat.cat_type,
      target,
      spent: catSpent,
      remaining: round2(target - catSpent),
    });
  }

  return {
    categories: rows,
    summary: { received: round2(received || 0) },
  };
}

module.exports = { BUDGETABLE, isBudgetable, monthPrefix, buildBudget };
