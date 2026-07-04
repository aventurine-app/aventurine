'use strict';

// Category serialisation — port of services/categories.py.

const VALID_CAT_TYPES = ['income', 'expense', 'savings', 'investing'];

// The spend character bound to a category: a fixed cost, a flexible cost, or a
// savings/investing goal. Surfaced as the Fixed/Flex/Goal toggle in category
// settings; 'flex' is the default. Stored and round-tripped only — no
// computation consumes it since the budgeting feature was removed.
const VALID_FLEX_TYPES = ['fixed', 'flex', 'goal'];

function serialiseCategory(c) {
  return {
    id: c.id,
    key: c.key,
    name: c.name,
    cat_type: c.cat_type,
    flex_type: c.flex_type,
    position: c.position,
  };
}

module.exports = { VALID_CAT_TYPES, VALID_FLEX_TYPES, serialiseCategory };
