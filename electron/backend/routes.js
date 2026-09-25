'use strict';

// The full route table. Order matters only
// where a typed converter disambiguates two patterns that would otherwise both
// match: '/api/transactions/similar' vs '/api/transactions/<int:tx_id>', where
// the int pattern cannot match the literal 'similar'.

const { buildRouter } = require('./router');

const routes = [
  ...require('./handlers/incomeExpenses').routes,
  ...require('./handlers/categories').routes,
  ...require('./handlers/transactions').routes,
  ...require('./handlers/portfolio').routes,
  ...require('./handlers/forecast').routes,
  ...require('./handlers/trends').routes,
  ...require('./handlers/topMerchants').routes,
  ...require('./handlers/transfers').routes,
  ...require('./handlers/recurring').routes,
  ...require('./handlers/budgets').routes,
  ...require('./handlers/reportCard').routes,
  ...require('./handlers/appSettings').routes,
  ...require('./handlers/onboarding').routes,
  ...require('./handlers/database').routes,
  ...require('./handlers/balanceSheet').routes,
];

const router = buildRouter(routes);

module.exports = { routes, dispatch: router.dispatch };
