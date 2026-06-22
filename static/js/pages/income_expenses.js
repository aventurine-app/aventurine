'use strict';

// ─── Cash Flow page ─────────────────────────────────────────────────────────
// All table behavior lives in tables.js (loaded before this file). This page
// just hands the shared controller its specific shape:
//
//   • Four column types — Income, Expense, Savings, Investing — which group
//     columns into labelled sections in the rendered table.
//   • A totals tfoot per year, since flow values are naturally summable.
//   • hideColumnManager: true — column CRUD lives in Settings → Categories.
//   • syncEnabled: true — each year-table's ⋮ menu gets a "Sync Settings" item
//     to choose which categories are computed from transactions for that year.

bootstrapYearTablePage({
    apiPrefix: '/api',
    types: [
        { key: 'income',    label: 'Income' },
        { key: 'expense',   label: 'Expense' },
        { key: 'savings',   label: 'Savings' },
        { key: 'investing', label: 'Investing' },
    ],
    includeTotals:     true,
    hideColumnManager: true,
    syncEnabled:       true,
});
