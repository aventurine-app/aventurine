'use strict';

// ============================================================================
// store.js — Shared client-side cache of the user's data.
// ============================================================================
//
// Loaded by pages/partials/scripts.html BEFORE every per-page script. Provides a single
// in-memory snapshot of the year-table datasets, backed by sessionStorage so
// that navigating between pages reuses the data instead of refetching.
//
// API
// ───
//   Store.ensure(name)        → Promise<data>
//       Returns the dataset for `name`. If it is already in memory, resolves
//       from cache. If a sessionStorage cache exists, returns it immediately and
//       revalidates in the background (subscribers are notified when fresh data
//       arrives). Otherwise fetches first.
//
//   Store.mutate(name, fn)
//       Apply `fn(data)` to the live dataset in place; persist + notify.
//       Use for known small updates where mirroring the change in JS is
//       cheaper than refetching.
//
//   Store.invalidate(name)    → Promise<void>
//       Drop the cached dataset (memory + sessionStorage). The refetch is
//       deferred to the next ensure(), so the caller is not blocked on a
//       round-trip it does not need. Use after multi-row changes (column add,
//       year duplicate) where mirroring in JS would be error-prone.
//       Tracker pages (tables.js makeYearTableApi) call this after every
//       write so aggregator pages always pull fresh data on their next read.
//
//   Store.subscribe(name, fn) → unsubscribe()
//       Register a callback fired whenever the dataset changes (revalidation,
//       mutate, invalidate). The callback receives the latest dataset.
//
//   Store.setPersistence(on)
//       Allow or forbid the sessionStorage half of the cache. See the
//       persistence note below; shell/dbactions.js is the only caller.
//
//   Store.clearAll()
//       Drop every dataset, memory and sessionStorage both. Called when the
//       database is locked (shell/dbactions.js).
//
// Datasets
// ────────
//   'ie'        → /api/data          (Income + Expense + Savings + Investing)
//   'balance'   → /api/balance/data
//   'portfolio' → /api/portfolio/data
//
// sessionStorage (not localStorage) is intentional: the cache should not
// outlive the browser tab session. A new tab gets a fresh fetch so the user
// is never looking at stale data from a previous session.
//
// PERSISTENCE IS OFF UNTIL THE BACKEND SAYS OTHERWISE
// ───────────────────────────────────────────────────
// "Should not outlive the tab session" is the intent, but under Electron it is
// not what happens: Chromium keeps sessionStorage in a LevelDB under the app
// profile, so these payloads land on disk and stay there. For an ENCRYPTED
// database that is a plaintext mirror of the ledger sitting a directory away
// from the SQLCipher file, which defeats the encryption the user asked for.
//
// So persistence is gated on GET /api/db/status, which dbactions.js already
// reads on every page load: it calls setPersistence(!encrypted). Until that
// answer arrives `persist` is null, and null behaves like false in BOTH
// directions.
//
// Refusing to READ while the answer is outstanding is the half that is easy to
// miss. An encrypted database starts LOCKED, every data route answers 423, and
// a warm read would put the previous session's figures on screen behind the
// unlock prompt — the one thing the lock exists to prevent.
//
// ensure() therefore WAITS for the answer before it consults the cache, rather
// than racing it. Measured, the answer lands ~2ms after the shared script block
// parses and DOMContentLoaded is ~400ms later, so a page script calling ensure()
// would win that race every time anyway — but "every time" is a timing margin,
// and this decision is the one keeping a locked database's figures off screen.
// Waiting makes it structural instead, for a cost of nothing on the measured
// path. PERSIST_WAIT_MS only bounds a backend that never answers at all, and it
// expires into the CLOSED state, so the fallback is still no cache.

(function () {
    const Store = (() => {
        const DATASETS = {
            ie:        '/api/data',
            balance:   '/api/balance/data',
            portfolio: '/api/portfolio/data',
        };
        // Bump the version suffix whenever the cached data shape changes so old
        // sessionStorage entries are naturally ignored rather than causing errors.
        const STORAGE_PREFIX = 'fl-store-v2-';

        const state    = {};        // name -> dataset
        const inflight = {};        // name -> Promise (dedupes concurrent fetches)
        const subs     = new Map(); // name -> Set<callback>

        // null = the backend has not answered yet; treated as false on read and
        // on write. See the persistence note in the header.
        let persist = null;
        // Resolves the first time setPersistence is called, whichever way. Only
        // a backend that never answers at all reaches the timeout, and dbactions
        // answers false on a failed status read so even that path settles.
        const PERSIST_WAIT_MS = 2000;
        let _answerPersist;
        const persistAnswered = new Promise((resolve) => { _answerPersist = resolve; });

        function _readCache(name) {
            if (persist !== true) return null;
            try {
                const raw = sessionStorage.getItem(STORAGE_PREFIX + name);
                return raw ? JSON.parse(raw) : null;
            } catch (_) {
                return null;
            }
        }

        function _writeCache(name) {
            if (persist !== true) return;
            try {
                sessionStorage.setItem(STORAGE_PREFIX + name, JSON.stringify(state[name]));
            } catch (_) {
                // Quota exceeded or sessionStorage disabled — keep going. The
                // in-memory copy is still valid for the current page load.
            }
        }

        function _dropCache(name) {
            try {
                sessionStorage.removeItem(STORAGE_PREFIX + name);
            } catch (_) { /* same as above */ }
        }

        function _notify(name) {
            const fns = subs.get(name);
            if (!fns) return;
            for (const fn of fns) {
                try { fn(state[name]); }
                catch (err) { console.error('Store subscriber threw:', err); }
            }
        }

        async function _fetchFresh(name) {
            const r = await apiFetch(DATASETS[name]);
            if (!r.ok) throw new Error(`Store.ensure(${name}) failed: ${r.status}`);
            state[name] = await r.json();
            _writeCache(name);
            _notify(name);
            return state[name];
        }

        function ensure(name) {
            // Object.hasOwn, not `in`: `in` walks the prototype chain, so a name
            // like "constructor" or "toString" would pass the allowlist and then
            // reach state[name] / DATASETS[name]. hasOwn checks own properties
            // only.
            if (!Object.hasOwn(DATASETS, name)) {
                return Promise.reject(new Error(`Store: unknown dataset "${name}"`));
            }

            // Hot path: already in memory, and needs no answer from anyone.
            if (state[name]) return Promise.resolve(state[name]);

            return _ensureFetched(name);
        }

        async function _ensureFetched(name) {
            // The cache may not be consulted until persistence is settled — see
            // the header. Awaiting rather than racing is what makes that a
            // guarantee instead of a timing margin.
            await Promise.race([
                persistAnswered,
                new Promise(resolve => setTimeout(resolve, PERSIST_WAIT_MS)),
            ]);

            // Another caller may have filled it while we waited.
            if (state[name]) return state[name];

            // Warm path: sessionStorage has it. Return it now, revalidate behind.
            const cached = _readCache(name);
            if (cached) {
                state[name] = cached;
                if (!inflight[name]) {
                    inflight[name] = _fetchFresh(name)
                        .catch(err => { console.error(err); })
                        .finally(() => { delete inflight[name]; });
                }
                return cached;
            }

            // Cold path: must fetch before we can return anything.
            if (!inflight[name]) {
                inflight[name] = _fetchFresh(name)
                    .finally(() => { delete inflight[name]; });
            }
            return inflight[name];
        }

        function mutate(name, fn) {
            if (!state[name]) return;   // nothing cached yet — next ensure() will fetch
            fn(state[name]);
            _writeCache(name);
            _notify(name);
        }

        function invalidate(name) {
            delete state[name];
            _dropCache(name);
            // Re-fetch on next ensure() — don't block the caller here.
            return Promise.resolve();
        }

        function subscribe(name, fn) {
            if (!subs.has(name)) subs.set(name, new Set());
            subs.get(name).add(fn);
            return () => subs.get(name)?.delete(fn);
        }

        /** Allow (or forbid) the sessionStorage half of the cache — see the
         *  persistence note in the header. Turning it ON flushes whatever was
         *  fetched while the answer was outstanding, so a cold page load still
         *  warms the cache for the next navigation. Turning it OFF purges every
         *  dataset, which is also what clears entries an earlier build wrote
         *  before this gate existed. */
        function setPersistence(on) {
            const next = !!on;
            _answerPersist();          // releases any ensure() waiting on the answer
            if (persist === next) return;
            persist = next;
            if (next) {
                for (const name of Object.keys(state)) _writeCache(name);
            } else {
                for (const name of Object.keys(DATASETS)) _dropCache(name);
            }
        }

        /** Drop every dataset, in memory and on disk. Used when the database is
         *  locked: the rendered figures go off screen, and the copies backing
         *  them go with it. Subscribers are deliberately NOT notified — the only
         *  way out of a locked database reloads the page, so there is nothing to
         *  re-render into. */
        function clearAll() {
            for (const name of Object.keys(DATASETS)) {
                delete state[name];
                _dropCache(name);
            }
        }

        return { ensure, mutate, invalidate, subscribe, setPersistence, clearAll };
    })();

    window.Store = Store;
}());
