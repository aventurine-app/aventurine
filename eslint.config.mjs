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
// exactly one IIFE-wrapped file, which attaches it via an explicit
// `window.X = X` at its bottom, and is read-only everywhere (shadowing
// inside the defining file's IIFE is fine). Grouped by defining file:
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
  // core/format.js
  debounce: 'readonly',
  applyCommaFormat: 'readonly',
  formatDisplay: 'readonly',
  // widgets/tables.js
  confirmDelete: 'readonly',
  promptAddYear: 'readonly',
  bootstrapYearTablePage: 'readonly',
  // widgets/txparse.js (pure parsing core; also require()d by the backend
  // test suite) / txfileimport.js / txexport.js
  TxParse: 'readonly',
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

  // txparse.js is dual-environment — a browser classic script that also
  // module.exports itself for the backend test suite. Declare `module` so
  // its typeof-guarded CJS branch lints.
  {
    files: ['static/js/widgets/txparse.js'],
    languageOptions: { globals: { module: 'readonly' } },
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
