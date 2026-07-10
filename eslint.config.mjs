// ─── ESLint flat config ──────────────────────────────────────────────────────
// Dev-only static analysis; nothing here affects what ships (the app remains
// build-step-free — see PRODUCT.md). Run via `npm run lint` from electron/
// (ESLint itself lives in electron/node_modules; this file sits at the repo
// root so both the frontend and the backend are covered by one config).
//
// Two very different JS worlds live in this repo:
//
//   static/js/**        Classic browser <script>s, no modules. Files share
//                       one global scope; cross-file names must be declared
//                       in `globals` below or no-undef flags them. That is
//                       deliberate — the globals list documents the app's
//                       real cross-file API surface, and anything NOT listed
//                       stays an error, which catches typos and undeclared
//                       cross-file coupling alike.
//
//   electron/**         CommonJS under Node (main process, backend, scripts,
//                       node:test suites).
//
// electron/dist/** holds packaged copies of static/js — never lint those.

// The repo's only node_modules lives in electron/ (there is deliberately no
// root package.json), so resolve ESLint's helper packages from there rather
// than via bare ESM imports, which would only search upward from this file.
import { createRequire } from 'node:module';
const require = createRequire(new URL('./electron/', import.meta.url));
const js = require('@eslint/js');
const globals = require('globals');

// Cross-file globals the classic scripts share. Each entry is defined in
// exactly one file (writable there via the per-file overrides further down)
// and read-only everywhere else. Grouped by defining file:
const appGlobals = {
  // core/escape.js
  escapeHtml: 'readonly',
  // core/api.js
  apiFetch: 'readonly',
  // core/store.js
  Store: 'readonly',
  // core/currency.js
  CURRENCY_SYMBOL: 'readonly',
  formatCurrency: 'readonly',
  applyCurrencyFormat: 'readonly',
  stripCurrencyValue: 'readonly',
  formatDate: 'readonly',
  setCurrencySymbol: 'readonly',
  setSymbolPosition: 'readonly',
  setHideCents: 'readonly',
  setNegativeStyle: 'readonly',
  setNumberFormat: 'readonly',
  setDateFormat: 'readonly',
  // core/encryption.js
  securityActions: 'readonly',
  // shell/ui.js
  UI: 'readonly',
  // shell/nav.js
  setUncatBadge: 'readonly',
  refreshUncatBadge: 'readonly',
  // shell/dbactions.js
  dbActions: 'readonly',
  // shell/zoom.js
  olivZoom: 'readonly',
  // widgets/chart.js
  FinanceChart: 'readonly',
  // widgets/cellselect.js
  enableCellSelection: 'readonly',
  // widgets/tables.js (also the de-facto shared-utils home — see the
  // engineering-review notes; candidates for extraction to core/)
  debounce: 'readonly',
  applyCommaFormat: 'readonly',
  formatDisplay: 'readonly',
  openTableMenu: 'readonly',
  confirmDelete: 'readonly',
  promptAddYear: 'readonly',
  bootstrapYearTablePage: 'readonly',
  // widgets/txfileimport.js / txexport.js
  TxFileImport: 'readonly',
  TxFileExport: 'readonly',
  // electron/preload.js contextBridge surface (undefined in plain browsers;
  // code must feature-detect before use)
  electronWindow: 'readonly',
  electronFile: 'readonly',
  financeApi: 'readonly',
};

export default [
  {
    ignores: [
      'electron/dist/**',
      '**/node_modules/**',
    ],
  },

  js.configs.recommended,

  // Rules shared by both worlds.
  {
    rules: {
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      // The codebase uses `== null` deliberately (matches both null and
      // undefined); everything else must be strict.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // `catch { /* comment explaining why */ }` is an accepted pattern for
      // best-effort cleanup; no-empty still flags truly bare blocks elsewhere.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Frontend: classic scripts in the renderer.
  {
    files: ['static/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...appGlobals,
      },
    },
  },

  // Each defining file may (re)declare / write its own global.
  {
    files: ['static/js/core/escape.js'],
    languageOptions: { globals: { escapeHtml: 'off' } },
  },
  {
    files: ['static/js/core/currency.js'],
    languageOptions: {
      globals: {
        CURRENCY_SYMBOL: 'off', formatCurrency: 'off', applyCurrencyFormat: 'off',
        stripCurrencyValue: 'off', formatDate: 'off', setCurrencySymbol: 'off',
        setSymbolPosition: 'off', setHideCents: 'off', setNegativeStyle: 'off',
        setNumberFormat: 'off', setDateFormat: 'off',
      },
    },
  },
  {
    files: ['static/js/core/store.js'],
    languageOptions: { globals: { Store: 'off' } },
  },
  {
    files: ['static/js/shell/ui.js'],
    languageOptions: { globals: { UI: 'off' } },
  },
  {
    files: ['static/js/widgets/tables.js'],
    languageOptions: {
      globals: {
        debounce: 'off', applyCommaFormat: 'off', formatDisplay: 'off',
        openTableMenu: 'off', confirmDelete: 'off', promptAddYear: 'off',
        bootstrapYearTablePage: 'off',
      },
    },
  },
  {
    files: ['static/js/widgets/cellselect.js'],
    languageOptions: { globals: { enableCellSelection: 'off' } },
  },
  {
    files: ['static/js/widgets/chart.js'],
    languageOptions: { globals: { FinanceChart: 'off' } },
  },
  {
    files: ['static/js/widgets/txfileimport.js'],
    languageOptions: { globals: { TxFileImport: 'off' } },
  },
  {
    files: ['static/js/widgets/txexport.js'],
    languageOptions: { globals: { TxFileExport: 'off' } },
  },

  // Electron main process, backend, build/train scripts, tests: Node CJS.
  {
    files: ['electron/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },

  // This config file itself: Node ESM.
  {
    files: ['eslint.config.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: globals.node,
    },
  },
];
