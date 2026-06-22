'use strict';

// ─── About & Updates modal wiring ───────────────────────────────────────────
// Drives the Updates card in the About modal (pages/partials/chrome.html) off
// the electronUpdater preload bridge (electron/updater.js). Always shows the
// installed version; the Updates card only appears when auto-update is actually
// supported (packaged Windows). In a plain browser the bridge is absent and we
// no-op past everything.

(function () {
    const modal = document.querySelector('[data-modal="about"]');
    if (!modal) return;

    const versionEl  = modal.querySelector('[data-about-version]');
    const updatesEl  = modal.querySelector('[data-about-updates]');
    const statusEl   = modal.querySelector('[data-update-status]');
    const progressEl = modal.querySelector('[data-update-progress]');
    const barEl      = modal.querySelector('[data-update-progress-bar]');
    const checkBtn    = modal.querySelector('[data-update-action="check"]');
    const downloadBtn = modal.querySelector('[data-update-action="download"]');
    const installBtn  = modal.querySelector('[data-update-action="install"]');

    const updater = window.electronUpdater;
    // Plain browser / no bridge: leave the version as-is, keep Updates hidden.
    if (!updater) return;

    function setVersion(v) {
        if (v && versionEl) versionEl.textContent = v;
    }

    function showButtons({ check = false, download = false, install = false }) {
        checkBtn.hidden = !check;
        downloadBtn.hidden = !download;
        installBtn.hidden = !install;
    }

    function setProgress(percent) {
        if (percent == null) { progressEl.hidden = true; return; }
        progressEl.hidden = false;
        barEl.style.width = Math.max(0, Math.min(100, percent)).toFixed(1) + '%';
    }

    // Render one status object pushed from (or polled out of) the main process.
    function render(status) {
        if (!status) return;
        setVersion(status.version);

        switch (status.state) {
            case 'checking':
                statusEl.textContent = 'Checking for updates…';
                setProgress(null);
                showButtons({ check: false });
                checkBtn.disabled = true;
                break;
            case 'up-to-date':
                statusEl.textContent = 'Oliv is up to date.';
                setProgress(null);
                checkBtn.disabled = false;
                showButtons({ check: true });
                break;
            case 'available':
                statusEl.textContent = `Version ${status.newVersion} is available.`;
                setProgress(null);
                showButtons({ download: true });
                break;
            case 'downloading':
                statusEl.textContent = 'Downloading update…';
                setProgress(status.percent ?? 0);
                showButtons({});
                break;
            case 'downloaded':
                statusEl.textContent = `Version ${status.newVersion} is ready to install.`;
                setProgress(null);
                showButtons({ install: true });
                break;
            case 'error':
                statusEl.textContent = `Update failed: ${status.message || 'unknown error'}`;
                setProgress(null);
                checkBtn.disabled = false;
                showButtons({ check: true });
                break;
            default: // idle
                statusEl.textContent = 'Check for a newer version of Oliv.';
                setProgress(null);
                checkBtn.disabled = false;
                showButtons({ check: true });
        }
    }

    checkBtn.addEventListener('click', () => updater.check());
    downloadBtn.addEventListener('click', () => updater.download());
    installBtn.addEventListener('click', () => updater.install());

    // Status is pushed asynchronously from the main process.
    updater.onStatus(render);

    // Pull the current state once so the modal reflects reality on first open
    // (e.g. an update found during the launch check, before this page loaded).
    updater.getState().then(state => {
        setVersion(state?.version);
        // Reveal the Updates card only where auto-update can actually run.
        if (state?.supported) {
            updatesEl.hidden = false;
            render(state);
        }
    }).catch(() => { /* bridge present but call failed — stay hidden */ });
}());
