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
        // Sync active state on every instance of the theme buttons.
        document.querySelectorAll('.settings-theme-btn').forEach(btn => {
            btn.classList.toggle('active', (btn.dataset.theme ?? '') === (theme ?? ''));
        });
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
    // AFTER this file (see scripts.html order), so window.olivZoom doesn't exist
    // yet while settings.js executes — wiring it now would no-op. Defer to
    // DOMContentLoaded, by which point every body script (incl. zoom.js) has run.
    // The row stays hidden in a plain browser where window.olivZoom is absent.

    function wireZoom() {
        if (!window.olivZoom) return;
        document.querySelectorAll('.settings-zoom-row').forEach(row => { row.hidden = false; });

        const render = () => {
            document.querySelectorAll('.settings-zoom-value').forEach(el => {
                el.textContent = window.olivZoom.percent() + '%';
            });
        };
        document.querySelectorAll('.settings-zoom-btn, .settings-zoom-reset').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.zoomAction;
                if (action === 'in') window.olivZoom.zoomIn();
                else if (action === 'out') window.olivZoom.zoomOut();
                else if (action === 'reset') window.olivZoom.reset();
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
        'symbol_position', 'hide_cents', 'negative_style', 'date_format', 'zoom_level',
    ];

    async function restoreDefaults() {
        if (!window.confirm('Reset all preferences to their defaults? This affects only settings, not your financial data.')) {
            return;
        }
        // Reset the DB-backed matching settings to their seed values.
        await Promise.all([
            saveAppSetting('tx_auto_match', 'on'),
            saveAppSetting('tx_fuzzy_threshold', '1'),
        ]).catch(() => { /* non-critical; defaults still apply on reload */ });
        // Snap the live zoom back to 100% before clearing its key (a stored
        // webContents zoom otherwise survives the reload).
        if (window.olivZoom) window.olivZoom.reset();
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
    // The auto-categorization radio group plus the match-strength slider, both
    // backed by /api/app-settings. One cached fetch serves every widget; radios
    // are selected by their name attribute since they share the .settings-match-*
    // styling classes.

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


    // ── Match strength slider ─────────────────────────────────────────────────
    // The single control for similar-transaction matching: 100% = exact,
    // anything lower is fuzzy. The label tracks the slider live; the value is
    // persisted on release (change), not on every drag tick.

    function pct(v) { return Math.round(Number(v) * 100) + '%'; }

    function setThresholdLabel(slider) {
        const label = slider.closest('.settings-threshold-control')
            ?.querySelector('.settings-threshold-value');
        if (label) label.textContent = pct(slider.value);
    }

    async function wireFuzzyThreshold() {
        const settings = await loadAppSettings();
        const value = settings.tx_fuzzy_threshold || '1';
        // Exclude the auto-lock slider, which shares the threshold-slider styling
        // classes but is a minutes control, not the 0–1 fuzzy threshold.
        const SEL = '.settings-threshold-slider:not(.settings-autolock-slider)';
        document.querySelectorAll(SEL).forEach(slider => {
            slider.value = value;
            setThresholdLabel(slider);
            // Live label + keep any coexisting instance (page + modal) in sync.
            slider.addEventListener('input', () => {
                document.querySelectorAll(SEL).forEach(other => {
                    if (other !== slider) other.value = slider.value;
                    setThresholdLabel(other);
                });
            });
            slider.addEventListener('change', () => {
                saveAppSetting('tx_fuzzy_threshold', slider.value);
            });
        });
    }

    wireSettingRadios('tx_auto_match', 'on');
    wireFuzzyThreshold();
}());
