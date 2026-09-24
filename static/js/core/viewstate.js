'use strict';

// ─── Per-window view state ───────────────────────────────────────────────────
//
// A scratch bag for "where the user had got to on this page" — the Transactions
// filters today — that survives leaving the page and is there again when they
// come back. Each page is its own document under app:// (PAGE_ROUTES in
// electron/main.js), so every navigation throws the JS heap away; anything a
// page wants to find on its return has to live outside it.
//
// It lives in window.name, which is unusual enough to be worth justifying:
//
//   • sessionStorage, the obvious choice, is a LevelDB file under the app's
//     userData directory — see the note in core/store.js, which is why the
//     dataset cache is gated behind Store.setPersistence. View state includes
//     the description search, so keeping it there would write ledger-derived
//     text to disk beside a database the user may have encrypted, and would
//     need that same gate (which would leave encrypted databases with no
//     memory at all). window.name never reaches disk.
//   • localStorage is worse on both counts: it also outlives the window.
//   • The main process could hold it, but that widens the preload bridge for
//     what is renderer-only bookkeeping.
//
// Lifetime is the window's: closing the app forgets everything, which is the
// right span for a view preference. Nothing stored here is authoritative — every
// reader has to cope with a missing, stale or malformed value, because that is
// exactly what it gets on the first load after a restart.
//
// window.name is one string shared by the whole window, so this holds a single
// JSON object and each caller takes a named slot in it. Keep the values small:
// this is for a filter set or a tab name, not for data.

(function () {
    // Tags the object as ours, so a window.name set by anything else is left
    // alone rather than parsed, overwritten or cleared.
    const TAG = 'aventurine:viewstate';

    /** The parsed bag, or null when window.name is unset, malformed, or not ours. */
    function readBag() {
        try {
            const bag = JSON.parse(window.name);
            return (bag && bag.tag === TAG && bag.slots) ? bag : null;
        } catch {
            return null;
        }
    }

    const ViewState = {
        /** The value stored under `key`, or null if there isn't one. */
        get(key) {
            const bag = readBag();
            // hasOwn, not `in`: `in` walks the prototype chain, so a key like
            // "constructor" would otherwise report a value that was never stored.
            return bag && Object.hasOwn(bag.slots, key) ? bag.slots[key] : null;
        },

        /** Store `value` under `key`. It must survive a JSON round trip. */
        set(key, value) {
            const bag = readBag() || { tag: TAG, slots: {} };
            bag.slots[key] = value;
            try {
                window.name = JSON.stringify(bag);
            } catch {
                // Unserialisable value (a cycle, a BigInt). The page in front of
                // the user is unaffected; it just won't be restored next time.
            }
        },

        /** Forget everything. Called when the open database changes
         *  (shell/dbactions.js), so one database's view cannot be restored on
         *  top of another's data. */
        clear() {
            if (readBag()) window.name = '';
        },
    };

    window.ViewState = ViewState;
}());
