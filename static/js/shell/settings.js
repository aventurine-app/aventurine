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

    // 'colorful' is light with an accent sidebar and is the default when nothing
    // is stored (DEFAULT_THEME), '' is plain light, 'dark' is dark, 'system'
    // follows the OS. resolveTheme turns the stored choice into the
    // data-theme value actually painted — only 'system' needs resolving, so a
    // new theme is a CSS block plus a picker button and nothing here.
    // Matches the same fallback in shell/theme-init.js, which paints pre-load.
    const DEFAULT_THEME = 'colorful';

    // The stored choice, with the shipped default standing in for an absent key.
    // '' is read straight through, so plain Light stays a remembered choice.
    function savedTheme() {
        const v = localStorage.getItem('color-theme');
        return v === null ? DEFAULT_THEME : v;
    }

    function resolveTheme(theme) {
        if (theme === 'system') return _prefersDark.matches ? 'dark' : '';
        return theme;
    }

    // Switching the theme swaps tokens on <html>, so everything painted by CSS
    // updates immediately. Only the charts go stale, since they write
    // --chart-*/--accent-primary into SVG attributes at draw time; the
    // 'themechange' event (the same shape as 'currencychange') makes them repaint
    // from the state they hold. This used to reload the page instead, which
    // closed the open Settings modal.
    function applyTheme(theme) {
        const effective = resolveTheme(theme);
        if (effective) {
            document.documentElement.dataset.theme = effective;
        } else {
            delete document.documentElement.dataset.theme;
        }
        localStorage.setItem('color-theme', theme);
        syncThemeButtons();
        window.dispatchEvent(new CustomEvent('themechange', { detail: { theme, effective } }));
    }

    // Reflect the stored choice on every picker instance (page + title-bar modal).
    function syncThemeButtons() {
        const saved = savedTheme();
        document.querySelectorAll('.settings-theme-btn').forEach(btn => {
            btn.classList.toggle('active', (btn.dataset.theme ?? '') === saved);
        });
    }

    function wireThemeButtons() {
        syncThemeButtons();
        document.querySelectorAll('.settings-theme-btn').forEach(btn => {
            btn.addEventListener('click', () => applyTheme(btn.dataset.theme ?? ''));
        });
        // Re-resolve live when the OS flips while 'system' is selected.
        _prefersDark.addEventListener('change', () => {
            if (savedTheme() === 'system') applyTheme('system');
        });
    }

    wireThemeButtons();


    // ── Graph palette ─────────────────────────────────────────────────────────
    // The second appearance axis: the theme above sets the page colours, this
    // sets the chart colours, and the two combine (see themes.css). '' is the
    // accent-derived ramp — the default, and the reason it stores an empty string
    // rather than the word 'accent': an absent attribute uses the --chart-*
    // definitions in style.css, with no override block to keep in sync.
    //
    // Switching it is the same token swap the theme does, so it reuses the same
    // 'themechange' event to make the drawn charts repaint from the state they
    // hold. The charts re-read their colours off <html> for either axis, so a
    // second event name would duplicate this one and every listener would have
    // to bind both.
    function applyGraphTheme(palette) {
        if (palette) {
            document.documentElement.dataset.graphTheme = palette;
        } else {
            delete document.documentElement.dataset.graphTheme;
        }
        localStorage.setItem('graph-theme', palette);
        syncGraphButtons();
        window.dispatchEvent(new CustomEvent('themechange', { detail: { graphTheme: palette } }));
    }

    function syncGraphButtons() {
        const saved = localStorage.getItem('graph-theme') ?? '';
        document.querySelectorAll('.settings-graph-btn').forEach(btn => {
            btn.classList.toggle('active', (btn.dataset.graphTheme ?? '') === saved);
        });
    }

    function wireGraphButtons() {
        syncGraphButtons();
        document.querySelectorAll('.settings-graph-btn').forEach(btn => {
            btn.addEventListener('click', () => applyGraphTheme(btn.dataset.graphTheme ?? ''));
        });
    }

    wireGraphButtons();


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
    // Merchant brand icons (avatar.js), on by default. Off falls every avatar
    // back to the initials circle; refreshMerchantAvatars converts the ones
    // already drawn, so the change lands on the open page without a reload.
    wirePrefRadios('merchant_icons', 'merchant_icons', '1', (v) => {
        localStorage.setItem('merchant_icons', v);
        if (window.refreshMerchantAvatars) window.refreshMerchantAvatars();
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
    // AFTER this file (see scripts.html order), so window.aventurineZoom does not
    // exist while settings.js executes and wiring it here would do nothing. Defer
    // to DOMContentLoaded, by which point every body script (including zoom.js)
    // has run. The row stays hidden in a plain browser, where
    // window.aventurineZoom is absent.

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
        'color-theme', 'graph-theme', 'ui-density', 'merchant_icons', 'currency_symbol', 'number_format',
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
    // Auto-lock is localStorage-backed (default on, 5 min); autolock.js listens
    // for the 'autolockchange' event to re-arm. The encryption row opens the
    // dedicated modal (encryption.js) and shows the current encrypted/plain
    // state.
    //
    // Encryption is listed FIRST and the two auto-lock rows depend on it: locking
    // re-prompts for the password, so on a plaintext DB there is no password to
    // prompt for and the timer would have no effect. Both rows are therefore
    // dimmed until the DB is encrypted, rather than being controls with no
    // effect. The stored preference is not changed while dimmed, so encrypting a
    // DB restores the last selected value. Encrypt/decrypt reloads the page (see
    // core/encryption.js), so this state is read once at load and never
    // re-fetched.

    function setAutolockLabel(slider) {
        const label = slider.closest('.settings-threshold-control')
            ?.querySelector('.settings-autolock-value');
        if (label) label.textContent = slider.value + ' min';
    }

    // Pending until /api/db/status responds. Starts false so the controls do not
    // flash as usable on a plaintext DB; a failed status fetch falls back to
    // true, so an unreadable state does not disable the settings.
    let dbEncrypted = false;

    // Two independent conditions: the timer row needs encryption AND the
    // auto-lock switch on; the switch itself only needs encryption.
    function applyAutolockState() {
        const on = localStorage.getItem('auto_lock') !== '0';
        document.querySelectorAll('.settings-autolock-row').forEach(r => {
            r.classList.toggle('settings-row-disabled', !dbEncrypted);
        });
        document.querySelectorAll('.settings-pref-radio[name="auto_lock"]')
            .forEach(radio => { radio.disabled = !dbEncrypted; });
        document.querySelectorAll('.settings-autolock-slider').forEach(s => {
            s.disabled = !(dbEncrypted && on);
        });
        document.querySelectorAll('.settings-autolock-timer-row').forEach(r => {
            r.classList.toggle('settings-row-disabled', !(dbEncrypted && on));
        });
    }

    wirePrefRadios('auto_lock', 'auto_lock', '1', (v) => {
        localStorage.setItem('auto_lock', v);
        applyAutolockState();
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
    applyAutolockState();

    // Encryption: reflect current state, gate the auto-lock rows on it, and open
    // the manage modal (encryption.js, resolved lazily since it loads after this
    // file).
    apiFetch('/api/db/status')
        .then(r => r.json())
        .then(s => {
            dbEncrypted = !!s.encrypted;
            applyAutolockState();
            document.querySelectorAll('[data-enc-settings-status]').forEach(el => {
                el.textContent = s.encrypted ? 'Currently encrypted.' : 'Currently not encrypted.';
            });
        })
        .catch(() => {
            // Status unavailable — leave the hint blank and unblock the rows
            // rather than dimming settings over a failed read.
            dbEncrypted = true;
            applyAutolockState();
        });

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
        // The footer holds Restore Defaults, which only means something on a tab
        // of settings. A tab that carries data-footer="hide" (About) takes the
        // whole bar away rather than showing a button with nothing to restore.
        const footer = modal ? modal.querySelector('[data-settings-footer]') : null;

        function activate(tab, focus) {
            tabs.forEach(t => {
                const on = t === tab;
                t.classList.toggle('active', on);
                t.setAttribute('aria-selected', on ? 'true' : 'false');
                t.tabIndex = on ? 0 : -1;
            });
            panels.forEach(p => { p.hidden = p.dataset.tabpanel !== tab.dataset.tab; });
            if (footer) footer.hidden = tab.dataset.footer === 'hide';
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
