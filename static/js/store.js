'use strict';

// ============================================================================
// store.js — Shared client-side cache of the user's data.
// ============================================================================
//
// Loaded by base.html BEFORE every per-page script. Provides a single
// in-memory snapshot of the year-table datasets, backed by sessionStorage so
// that navigating between pages reuses the data instead of refetching.
//
// API
// ───
//   Store.ensure(name)        → Promise<data>
//       Returns the dataset for `name`. If it's already in memory, resolves
//       synchronously-ish from cache. If a sessionStorage cache exists,
//       returns it immediately and revalidates in the background (subscribers
//       are notified when fresh data lands). Otherwise fetches first.
//
//   Store.mutate(name, fn)
//       Apply `fn(data)` to the live dataset in place; persist + notify.
//       Use for known small updates where mirroring the change in JS is
//       cheaper than refetching.
//
//   Store.invalidate(name)    → Promise<data>
//       Drop the cached dataset and refetch. Use after multi-row changes
//       (column add, year duplicate) where mirroring in JS would be fragile.
//       Tracker pages (tables.js makeYearTableApi) call this after every
//       write so aggregator pages always pull fresh data on their next read.
//
//   Store.subscribe(name, fn) → unsubscribe()
//       Register a callback fired whenever the dataset changes (revalidation,
//       mutate, invalidate). The callback receives the latest dataset.
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

    function _readCache(name) {
        try {
            const raw = sessionStorage.getItem(STORAGE_PREFIX + name);
            return raw ? JSON.parse(raw) : null;
        } catch (_) {
            return null;
        }
    }

    function _writeCache(name) {
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
        // reach state[name] / DATASETS[name]. hasOwn checks own keys only.
        if (!Object.hasOwn(DATASETS, name)) {
            return Promise.reject(new Error(`Store: unknown dataset "${name}"`));
        }

        // Hot path: already in memory.
        if (state[name]) return Promise.resolve(state[name]);

        // Warm path: sessionStorage has it. Return it now, revalidate behind.
        const cached = _readCache(name);
        if (cached) {
            state[name] = cached;
            if (!inflight[name]) {
                inflight[name] = _fetchFresh(name)
                    .catch(err => { console.error(err); })
                    .finally(() => { delete inflight[name]; });
            }
            return Promise.resolve(cached);
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

    return { ensure, mutate, invalidate, subscribe };
})();

window.Store = Store;
