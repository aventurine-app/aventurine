'use strict';

// ─── autolock.js ────────────────────────────────────────────────────────────
// Locks an encrypted database after a period of user inactivity, then surfaces
// the existing unlock prompt. Locking just drops the in-memory key on the
// backend (POST /api/db/lock); the next data request answers 423 and the
// renderer re-prompts — same flow as a restart with an encrypted DB.
//
// Only an ENCRYPTED, currently-unlocked DB can be auto-locked: a plaintext file
// has no passphrase to re-enter, so there'd be nothing to protect. Settings:
//   localStorage 'auto_lock'         '1' (default, on) | '0'
//   localStorage 'auto_lock_minutes' minutes of inactivity (default 5)
// settings.js fires an 'autolockchange' event when either changes so the timer
// re-arms live.

(function () {
    if (!window.financeApi) return;   // only under the real app (has a backend)

    const ENABLED_KEY = 'auto_lock';
    const MINUTES_KEY  = 'auto_lock_minutes';

    const enabled = () => localStorage.getItem(ENABLED_KEY) !== '0';   // default on
    const minutes = () => {
        const m = parseFloat(localStorage.getItem(MINUTES_KEY));
        return Number.isFinite(m) && m > 0 ? m : 5;
    };

    let armed = false;   // true only while an encrypted+unlocked DB is active
    let timer = null;
    let lastArm = 0;     // timestamp of the most recent re-arm (for coalescing)

    // mousemove/scroll/wheel can fire hundreds of times per second; re-arming
    // the timer (which also reads localStorage twice) on every one of them is
    // needless churn. So an activity burst re-arms at most once per window.
    // The cost is that the lock may fire up to this much early after the user
    // goes idle — negligible against a timeout measured in minutes.
    const ACTIVITY_COALESCE_MS = 1000;

    function clear() {
        if (timer) { clearTimeout(timer); timer = null; }
    }

    function schedule() {
        clear();
        lastArm = Date.now();
        if (!armed || !enabled()) return;
        timer = setTimeout(lockNow, minutes() * 60 * 1000);
    }

    // Throttled re-arm for the high-frequency activity listeners (see above).
    function onActivity() {
        if (Date.now() - lastArm < ACTIVITY_COALESCE_MS) return;
        schedule();
    }

    async function lockNow() {
        clear();
        if (!armed) return;
        try {
            const res = await apiFetch('/api/db/lock', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    '{}',
            });
            const data = await res.json().catch(() => ({}));
            if (data && data.locked) {
                armed = false;   // don't re-arm; the unlock prompt is now showing
                if (window.dbActions) window.dbActions.showUnlock(data.path);
            }
        } catch {
            // Backend unreachable — leave it; a later activity tick retries.
        }
    }

    // Learn whether the active DB can be auto-locked, then start the timer.
    apiFetch('/api/db/status')
        .then(r => r.json())
        .then(s => { armed = !!s.encrypted && !s.locked; schedule(); })
        .catch(() => { /* status unavailable — stay disarmed */ });

    // Any sign of activity resets the countdown. Passive listeners keep this
    // off the scrolling/typing hot path; onActivity coalesces bursts so we
    // don't thrash the timer (and localStorage) on every mousemove.
    ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll']
        .forEach(ev => window.addEventListener(ev, onActivity, { passive: true }));

    // Settings toggled the option or timer — re-arm with the new values.
    window.addEventListener('autolockchange', schedule);
}());
