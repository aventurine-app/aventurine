'use strict';

// Category serialisation — port of services/categories.py.

const VALID_CAT_TYPES = ['income', 'expense', 'savings', 'investing'];

function serialiseCategory(c) {
  return {
    id: c.id,
    key: c.key,
    name: c.name,
    cat_type: c.cat_type,
    position: c.position,
  };
}

module.exports = { VALID_CAT_TYPES, serialiseCategory };
