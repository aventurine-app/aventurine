'use strict';

// The full route table — the Node counterpart of create_app()'s blueprint
// registration plus the year-table factory call. Order matters only where
// Flask's converters disambiguated (e.g. /api/transactions/similar vs
// <int:tx_id> — the int pattern can't match 'similar', same as Flask).

const { buildRouter } = require('./router');
const { yearTableRoutes } = require('./handlers/yearTable');

const routes = [
  ...require('./handlers/incomeExpenses').routes,
  ...require('./handlers/categories').routes,
  ...require('./handlers/transactions').routes,
  ...require('./handlers/portfolio').routes,
  ...require('./handlers/creditCards').routes,
  ...require('./handlers/predictions').routes,
  ...require('./handlers/forecast').routes,
  ...require('./handlers/trends').routes,
  ...require('./handlers/topMerchants').routes,
  ...require('./handlers/recurring').routes,
  ...require('./handlers/reportCard').routes,
  ...require('./handlers/appSettings').routes,
  ...require('./handlers/onboarding').routes,
  ...require('./handlers/database').routes,
  ...require('./handlers/license').routes,
  // Balance Sheet — the one remaining year-table feature (mirrors the
  // register_year_table_feature call in app.py).
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
