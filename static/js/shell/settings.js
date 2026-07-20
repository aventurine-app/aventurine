'use strict';

// ─── Settings widget wiring ─────────────────────────────────────────────────
// The settings widgets live in the title-bar Preferences modal (spliced in
// from pages/partials/chrome.html on every page). We wire every instance on
// the page independently — selectors use classes, not IDs, for that reason.

(function () {
    // ── Currency symbol ───────────────────────────────────────────────────────

    function wireCurrencyInput(input) {
        const row = input.closest('.settings-currency-row');
        const preview = row?.querySelector('.settings-currency-preview');
        if (!preview) return;

        const renderPreview = () => {
            // formatCurrency (currency.js) bakes in the symbol, group/decimal
            // style, symbol position, and hide-cents — so the preview tracks
            // every Format setting at once.
            preview.textContent = formatCurrency(1234.56);
        };

        input.value = CURRENCY_SYMBOL;
        renderPreview();

        input.addEventListener('input', () => {
            setCurrencySymbol(input.value);
            renderPreview();
            // Keep any other live instance of this input in sync.
            document.querySelectorAll('.settings-currency-input').forEach(other => {
                if (other !== input) other.value = input.value;
                const otherPreview = other.closest('.settings-currency-row')
                    ?.querySelector('.settings-currency-preview');
                if (otherPreview) otherPreview.textContent = preview.textContent;
            });
        });

        // Re-show the canonical value on blur so an empty input doesn't
        // look broken (setCurrencySymbol already falls back to '$').
        input.addEventListener('blur', () => { input.value = CURRENCY_SYMBOL; });
    }

    document.querySelectorAll('.settings-currency-input').forEach(wireCurrencyInput);


    // ── Color theme ───────────────────────────────────────────────────────────

    const _prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

    // 'system' follows the OS; '' is light, 'dark' is dark. resolveTheme turns
    // the stored choice into the data-theme value actually painted.
    function resolveTheme(theme) {
        if (theme === 'system') return _prefersDark.matches ? 'dark' : '';
        return theme;
    }

    function applyTheme(theme) {
        const effective = resolveTheme(theme);
        if (effective) {
            document.documentElement.dataset.theme = effective;
        } else {
            delete document.documentElement.dataset.theme;
        }
        localStorage.setItem('color-theme', theme);
        location.reload();
    }

    function wireThemeButtons() {
        const saved = localStorage.getItem('color-theme') ?? '';
        document.querySelectorAll('.settings-theme-btn').forEach(btn => {
            btn.classList.toggle('active', (btn.dataset.theme ?? '') === saved);
            btn.addEventListener('click', () => applyTheme(btn.dataset.theme ?? ''));
        });
        // Re-resolve live when the OS flips while 'system' is selected.
        _prefersDark.addEventListener('change', () => {
            if ((localStorage.getItem('color-theme') ?? '') === 'system') applyTheme('system');
        });
    }

    wireThemeButtons();


    // ── Display preferences (localStorage-backed pill toggles + selects) ───────
    // Density / symbol-position / hide-cents are simple radio pill toggles backed
    // by localStorage; number-format is a select. Each may exist twice (page +
    // title-bar modal), so we keep every instance in sync on change.

    function wirePrefRadios(name, key, fallback, onChange) {
        const saved = localStorage.getItem(key) ?? fallback;
        document.querySelectorAll(`.settings-pref-radio[name="${name}"]`).forEach(radio => {
            if (radio.value === saved) radio.checked = true;
            radio.addEventListener('change', () => {
                if (!radio.checked) return;
                document.querySelectorAll(`.settings-pref-radio[name="${name}"][value="${radio.value}"]`)
                    .forEach(r => { r.checked = true; });
                onChange(radio.value);
            });
        });
    }

    wirePrefRadios('ui-density', 'ui-density', '', (v) => {
        if (v === 'compact') document.documentElement.dataset.density = 'compact';
        else delete document.documentElement.dataset.density;
        localStorage.setItem('ui-density', v);
    });
    // These setters (currency.js) persist and fire 'currencychange' for re-render.
    wirePrefRadios('symbol_position', 'symbol_position', 'prefix', (v) => setSymbolPosition(v));
    wirePrefRadios('hide_cents', 'hide_cents', '', (v) => setHideCents(v === '1'));
    wirePrefRadios('negative_style', 'negative_style', 'minus', (v) => setNegativeStyle(v));
    // Read at use time by the Transactions date-filter quick ranges ("This week").
    wirePrefRadios('week_start', 'week_start', 'sunday', (v) => localStorage.setItem('week_start', v));

    // Format selects (number grouping + date style). Same shape: seed from
    // localStorage, persist via the currency.js setter, keep instances in sync.
    function wireSelect(selector, key, fallback, setter) {
        document.querySelectorAll(selector).forEach(sel => {
            sel.value = localStorage.getItem(key) || fallback;
            sel.addEventListener('change', () => {
                setter(sel.value);
                document.querySelectorAll(selector).forEach(o => { o.value = sel.value; });
            });
        });
    }
    wireSelect('.settings-number-format', 'number_format', 'us', setNumberFormat);
    wireSelect('.settings-date-format', 'date_format', 'long', setDateFormat);

    // Keep the currency preview chip in step with any Format change.
    window.addEventListener('currencychange', () => {
        document.querySelectorAll('.settings-currency-preview').forEach(p => {
            p.textContent = formatCurrency(1234.56);
        });
    });


    // ── Zoom (Electron only) ───────────────────────────────────────────────────
    // The control drives the shared zoom API in zoom.js. NOTE: zoom.js loads
    // AFTER this file (see scripts.html order), so window.aventurineZoom doesn't exist
    // yet while settings.js executes — wiring it now would no-op. Defer to
    // DOMContentLoaded, by which point every body script (incl. zoom.js) has run.
    // The row stays hidden in a plain browser where window.aventurineZoom is absent.

    function wireZoom() {
        if (!window.aventurineZoom) return;
        document.querySelectorAll('.settings-zoom-row').forEach(row => { row.hidden = false; });

        const render = () => {
            document.querySelectorAll('.settings-zoom-value').forEach(el => {
                el.textContent = window.aventurineZoom.percent() + '%';
            });
        };
        document.querySelectorAll('.settings-zoom-btn, .settings-zoom-reset').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.zoomAction;
                if (action === 'in') window.aventurineZoom.zoomIn();
                else if (action === 'out') window.aventurineZoom.zoomOut();
                else if (action === 'reset') window.aventurineZoom.reset();
            });
        });
        window.addEventListener('zoomchange', render);
        render();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wireZoom);
    } else {
        wireZoom();
    }


    // ── Restore defaults ───────────────────────────────────────────────────────
    // Clears every Preference back to its first-run default: the localStorage
    // display/format prefs AND the DB-backed transaction-matching settings. We
    // reload afterwards so every widget re-seeds from defaults in one shot,
    // rather than hand-resetting each control. Confirmed first — it's a wide
    // reset (though it only touches settings, never financial data).

    const PREF_KEYS = [
        'color-theme', 'ui-density', 'currency_symbol', 'number_format',
        'symbol_position', 'hide_cents', 'negative_style', 'date_format', 'week_start',
        'zoom_level',
    ];

    async function restoreDefaults() {
        if (!window.confirm('Reset all preferences to their defaults? This affects only settings, not your financial data.')) {
            return;
        }
        // Reset the DB-backed matching setting to its seed value.
        await saveAppSetting('tx_auto_match', 'on')
            .catch(() => { /* non-critical; defaults still apply on reload */ });
        // Snap the live zoom back to 100% before clearing its key (a stored
        // webContents zoom otherwise survives the reload).
        if (window.aventurineZoom) window.aventurineZoom.reset();
        PREF_KEYS.forEach(k => localStorage.removeItem(k));
        location.reload();
    }

    document.querySelectorAll('.settings-restore-defaults').forEach(btn => {
        btn.addEventListener('click', restoreDefaults);
    });


    // ── Security: auto-lock + database encryption ──────────────────────────────
    // Auto-lock is localStorage-backed (default on, 5 min); autolock.js watches
    // for the 'autolockchange' event to re-arm. The encryption row just opens the
    // dedicated modal (encryption.js) and reflects the live encrypted/plain state.

    function setAutolockLabel(slider) {
        const label = slider.closest('.settings-threshold-control')
            ?.querySelector('.settings-autolock-value');
        if (label) label.textContent = slider.value + ' min';
    }

    function setAutolockEnabled(on) {
        document.querySelectorAll('.settings-autolock-slider').forEach(s => { s.disabled = !on; });
        document.querySelectorAll('.settings-autolock-timer-row')
            .forEach(r => r.classList.toggle('settings-row-disabled', !on));
    }

    wirePrefRadios('auto_lock', 'auto_lock', '1', (v) => {
        localStorage.setItem('auto_lock', v);
        setAutolockEnabled(v === '1');
        window.dispatchEvent(new Event('autolockchange'));
    });

    document.querySelectorAll('.settings-autolock-slider').forEach(slider => {
        slider.value = localStorage.getItem('auto_lock_minutes') || '5';
        setAutolockLabel(slider);
        slider.addEventListener('input', () => {
            document.querySelectorAll('.settings-autolock-slider').forEach(other => {
                if (other !== slider) other.value = slider.value;
                setAutolockLabel(other);
            });
            setAutolockLabel(slider);
        });
        slider.addEventListener('change', () => {
            localStorage.setItem('auto_lock_minutes', slider.value);
            window.dispatchEvent(new Event('autolockchange'));
        });
    });
    setAutolockEnabled(localStorage.getItem('auto_lock') !== '0');

    // Encryption: reflect current state + open the manage modal (encryption.js,
    // resolved lazily since it loads after this file).
    apiFetch('/api/db/status')
        .then(r => r.json())
        .then(s => {
            document.querySelectorAll('[data-enc-settings-status]').forEach(el => {
                el.textContent = s.encrypted ? 'Currently encrypted.' : 'Currently not encrypted.';
            });
        })
        .catch(() => { /* status unavailable — leave the hint blank */ });

    document.querySelectorAll('.settings-manage-encryption').forEach(btn => {
        btn.addEventListener('click', () => {
            if (window.securityActions) window.securityActions.showEncryption();
        });
    });


    // ── Transaction matching settings ─────────────────────────────────────────
    // The auto-categorization radio group, backed by /api/app-settings. One
    // cached fetch serves every widget; radios are selected by their name
    // attribute since they share the .settings-match-* styling classes. (The
    // match-strength slider lives in the Transactions bulk-edit wizard now,
    // passed per request — it is no longer a stored setting.)

    let _appSettingsPromise = null;

    function loadAppSettings() {
        if (!_appSettingsPromise) {
            _appSettingsPromise = apiFetch('/api/app-settings')
                .then(res => (res.ok ? res.json() : {}))
                .catch(() => ({}));   // fall back to per-widget defaults
        }
        return _appSettingsPromise;
    }

    async function saveAppSetting(key, value) {
        // Keep all other instances in sync immediately (no refetch needed) —
        // the page and the Electron title-bar modal can coexist.
        document.querySelectorAll(`.settings-match-radio[name="${key}"][value="${value}"]`)
            .forEach(r => { r.checked = true; });
        try {
            await apiFetch('/api/app-settings/' + key, {
                method:  'PUT',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ value }),
            });
        } catch (_) { /* non-critical; next load will re-read from DB */ }
    }

    async function wireSettingRadios(key, fallback) {
        const settings = await loadAppSettings();
        const value = settings[key] || fallback;
        document.querySelectorAll(`.settings-match-radio[name="${key}"]`).forEach(radio => {
            if (radio.value === value) radio.checked = true;
            radio.addEventListener('change', () => {
                if (radio.checked) saveAppSetting(key, radio.value);
            });
        });
    }


    wireSettingRadios('tx_auto_match', 'on');


    // ── Delete all transactions (Transactions tab, danger zone) ────────────────
    // Irreversible: wipes the whole ledger (DELETE /api/transactions) but nothing
    // else. Because it's so destructive, the confirm modal keeps its button
    // disabled until the user types the exact phrase, and we reload afterward so
    // every surface re-reads from the now-empty table.

    const DELETE_ALL_TX_PHRASE = 'DELETE';

    function wireDeleteAllTx() {
        const overlay = document.querySelector('[data-modal="delete-all-tx"]');
        if (!overlay) return;
        const input  = overlay.querySelector('[data-delete-all-tx-input]');
        const submit = overlay.querySelector('[data-delete-all-tx-submit]');
        const cancel = overlay.querySelector('[data-delete-all-tx-cancel]');
        const error  = overlay.querySelector('[data-delete-all-tx-error]');

        const close = () => { overlay.hidden = true; };
        const reset = () => {
            input.value = '';
            submit.disabled = true;
            if (error) { error.hidden = true; error.textContent = ''; }
        };

        function open() {
            reset();
            overlay.hidden = false;
            input.focus();
        }

        input.addEventListener('input', () => {
            submit.disabled = input.value.trim() !== DELETE_ALL_TX_PHRASE;
        });
        // Enter submits once the phrase matches.
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !submit.disabled) { e.preventDefault(); run(); }
        });

        cancel.addEventListener('click', close);

        async function run() {
            if (input.value.trim() !== DELETE_ALL_TX_PHRASE) return;
            submit.disabled = true;
            try {
                const res = await apiFetch('/api/transactions', { method: 'DELETE' });
                if (!res.ok) throw new Error('request failed');
                location.reload();
            } catch (_) {
                if (error) {
                    error.textContent = 'Could not delete transactions. Please try again.';
                    error.hidden = false;
                }
                submit.disabled = false;
            }
        }

        submit.addEventListener('click', run);

        document.querySelectorAll('.settings-delete-all-tx').forEach(btn => {
            btn.addEventListener('click', open);
        });
    }

    wireDeleteAllTx();


    // ── Section tabs (Preferences modal) ───────────────────────────────────────
    // The Preferences sections are split across horizontal tabs. Each tab reveals
    // one .settings-tabpanel; inactive panels carry the [hidden] attribute. Roving
    // tabindex + arrow-key navigation follow the WAI-ARIA tabs pattern. Controls in
    // hidden panels stay in the DOM, so the class-based wiring above is unaffected.

    function wireSettingsTabs(tabBar) {
        const tabs = Array.from(tabBar.querySelectorAll('.settings-tab'));
        const modal = tabBar.closest('.settings-modal');
        const panels = modal ? Array.from(modal.querySelectorAll('.settings-tabpanel')) : [];

        function activate(tab, focus) {
            tabs.forEach(t => {
                const on = t === tab;
                t.classList.toggle('active', on);
                t.setAttribute('aria-selected', on ? 'true' : 'false');
                t.tabIndex = on ? 0 : -1;
            });
            panels.forEach(p => { p.hidden = p.dataset.tabpanel !== tab.dataset.tab; });
            if (focus) tab.focus();
        }

        tabs.forEach((tab, i) => {
            tab.addEventListener('click', () => activate(tab));
            tab.addEventListener('keydown', e => {
                let next = null;
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabs[(i + 1) % tabs.length];
                else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = tabs[(i - 1 + tabs.length) % tabs.length];
                else if (e.key === 'Home') next = tabs[0];
                else if (e.key === 'End') next = tabs[tabs.length - 1];
                if (next) { e.preventDefault(); activate(next, true); }
            });
        });
    }

    document.querySelectorAll('.settings-tabs').forEach(wireSettingsTabs);
}());
