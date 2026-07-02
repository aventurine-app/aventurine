'use strict';

// ─── Balance Sheet page ─────────────────────────────────────────────────────
// All table behavior lives in tables.js (loaded before this file). This page
// just hands the shared controller its specific shape:
//
//   - Four column types representing account categories: Cash, Investment,
//     Retirement, Debt. The column manager renders one section per type and
//     a four-button toggle for adding a new account-column.
//   - Section headers use a ' Accounts' suffix so they read
//     "Cash Accounts", "Investment Accounts", etc.
//   - No totals tfoot — balance values are point-in-time snapshots, not
//     flows, and summing them across months would be meaningless. Net worth
//     for the year is computed elsewhere (Home / Insights pages).
//   - addLayout is 'stacked' because four type-toggle buttons don't fit
//     inline next to the name input.
//   - 'cash' is the default for the Add toggle (most-common account type).
//   - syncEnabled: like Cash Flow, each year's ⋮ menu carries Sync Settings.
//     A synced column derives its values from the ledger + balance anchors
//     of the accounts linked to it (accounts.balance_column); only linked
//     columns are offered (the payload's `syncable` list) — an unlinked
//     column has no data source and stays hand-entered.

bootstrapYearTablePage({
    apiPrefix: '/api/balance',
    types: [
        { key: 'cash',       label: 'Cash' },
        { key: 'investment', label: 'Investment' },
        { key: 'retirement', label: 'Retirement' },
        { key: 'debt',       label: 'Debt' },
    ],
    typeSectionSuffix:   ' Accounts',
    includeTotals:       false,
    defaultAddType:      'cash',
    addLayout:           'stacked',
    addInputPlaceholder: 'Account name',
    syncEnabled:         true,
});
