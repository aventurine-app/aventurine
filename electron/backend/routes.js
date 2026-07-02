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
  ...require('./handlers/accounts').routes,
  ...require('./handlers/portfolio').routes,
  ...require('./handlers/creditCards').routes,
  ...require('./handlers/predictions').routes,
  ...require('./handlers/forecast').routes,
  ...require('./handlers/budget').routes,
  ...require('./handlers/trends').routes,
  ...require('./handlers/reportCard').routes,
  ...require('./handlers/appSettings').routes,
  ...require('./handlers/database').routes,
  // Balance Sheet — the one remaining year-table feature (mirrors the
  // register_year_table_feature call in app.py).
  ...yearTableRoutes({
    prefix: '/api/balance',
    yearTable: 'balance_active_years',
    entryTable: 'balance_entries',
    colTable: 'balance_columns',
    typeOrder: ['cash', 'investment', 'retirement', 'debt'],
    columnKeyPrefix: 'bcol',
  }),
];

const router = buildRouter(routes);

module.exports = { routes, dispatch: router.dispatch };
