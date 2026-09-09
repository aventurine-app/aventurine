'use strict';

// The full route table, plus the year-table factory call. Order matters only
// where a typed converter disambiguates two patterns that would otherwise both
// match: '/api/transactions/similar' vs '/api/transactions/<int:tx_id>', where
// the int pattern cannot match the literal 'similar'.

const { buildRouter } = require('./router');
const { yearTableRoutes } = require('./handlers/yearTable');

const routes = [
  ...require('./handlers/incomeExpenses').routes,
  ...require('./handlers/categories').routes,
  ...require('./handlers/transactions').routes,
  ...require('./handlers/portfolio').routes,
  ...require('./handlers/predictions').routes,
  ...require('./handlers/forecast').routes,
  ...require('./handlers/trends').routes,
  ...require('./handlers/topMerchants').routes,
  ...require('./handlers/transfers').routes,
  ...require('./handlers/recurring').routes,
  ...require('./handlers/reportCard').routes,
  ...require('./handlers/appSettings').routes,
  ...require('./handlers/onboarding').routes,
  ...require('./handlers/database').routes,
  ...require('./handlers/license').routes,
  // Balance Sheet — the one remaining year-table feature.
  ...yearTableRoutes({
    prefix: '/api/balance',
    yearTable: 'balance_active_years',
    entryTable: 'balance_entries',
    colTable: 'balance_columns',
    typeOrder: ['cash', 'investment', 'retirement', 'debt'],
    columnKeyPrefix: 'bcol',
    // Balance Sheet columns double as the app's accounts, so they carry the
    // starter-account `hidden` flag (see seed.js DEFAULT_BALANCE_COLUMNS).
    hasHidden: true,
  }),
];

const router = buildRouter(routes);

module.exports = { routes, dispatch: router.dispatch };
