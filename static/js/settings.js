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
            // CURRENCY_SYMBOL is a global from currency.js (loaded earlier
            // in base.html). Falls back to '$' if the user has cleared it.
            preview.textContent = (CURRENCY_SYMBOL || '$') + '1,234.56';
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

    function applyTheme(theme) {
        if (theme) {
            document.documentElement.dataset.theme = theme;
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
    }

    wireThemeButtons();


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
        document.querySelectorAll('.settings-threshold-slider').forEach(slider => {
            slider.value = value;
            setThresholdLabel(slider);
            // Live label + keep any coexisting instance (page + modal) in sync.
            slider.addEventListener('input', () => {
                document.querySelectorAll('.settings-threshold-slider').forEach(other => {
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
