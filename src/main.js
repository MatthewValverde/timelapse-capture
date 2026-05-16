/**
 * Timelapse Capture — entry point.
 * Wires up theme, settings, view switching, and shared modal/toast/storage helpers.
 */

import './styles.css';

import {
  mountCapture,
  onCaptureBecameVisible,
  onCaptureWillHide,
  teardownCapture,
} from './captureView.js';
import {
  mountPlayback,
  onPlaybackBecameVisible,
  onPlaybackWillHide,
  refreshList as refreshSetList,
} from './playbackView.js';
import { listCameras } from './camera.js';
import { getStorageEstimate } from './db.js';

/* -------------------- Settings -------------------- */

const SETTINGS_KEY = 'tlc:settings';

const defaultSettings = {
  theme: 'dark', // 'dark' | 'light'
  cameraDeviceId: null,
  quality: 'med', // 'low' | 'med' | 'high'
};

const settings = loadSettings();

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaultSettings };
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', settings.theme);
  // Update theme-color meta to match the bg
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', settings.theme === 'dark' ? '#0e0e10' : '#f5f4f0');
  }
}

/* -------------------- Toasts -------------------- */

const toastRoot = document.getElementById('toast-root');

function showToast(message, kind = 'info', duration = 3000) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' is-error' : kind === 'success' ? ' is-success' : '');
  el.textContent = message;
  toastRoot.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 240ms';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 280);
  }, duration);
}

function showProgressToast(initialMessage) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = initialMessage;
  toastRoot.appendChild(el);
  return {
    update(msg) {
      el.textContent = msg;
    },
    close() {
      el.style.transition = 'opacity 240ms';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 280);
    },
  };
}

/* -------------------- Modals -------------------- */

const modalRoot = document.getElementById('modal-root');
let _modalCleanupTimer = null;

/**
 * Show a modal with optional fields and action buttons.
 * Returns Promise<{ action, values } | null>
 */
function showModal({ title, subtitle, fields = [], actions = [], defaultAction }) {
  // Cancel any pending teardown of a previous modal — we're replacing it now.
  if (_modalCleanupTimer) {
    clearTimeout(_modalCleanupTimer);
    _modalCleanupTimer = null;
  }
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal__head">
        <div class="modal__title">${escapeHtml(title || '')}</div>
        ${subtitle ? `<div class="modal__subtitle">${escapeHtml(subtitle)}</div>` : ''}
      </div>
      <div class="modal__body">
        ${fields
          .map((f) => {
            if (f.type === 'select') {
              return `
                <select class="select" data-field="${f.id}">
                  ${f.options
                    .map(
                      (o) =>
                        `<option value="${escapeHtml(o.value)}" ${o.value === f.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
                    )
                    .join('')}
                </select>
              `;
            }
            return `
              <input
                class="input"
                type="text"
                data-field="${f.id}"
                placeholder="${escapeHtml(f.placeholder || '')}"
                value="${escapeHtml(f.value || '')}"
                ${f.autofocus ? 'autofocus' : ''}
              />
            `;
          })
          .join('')}
      </div>
      <div class="modal__foot">
        ${actions
          .map(
            (a) =>
              `<button class="btn btn--${a.kind || 'primary'}" data-action="${a.id}">${escapeHtml(a.label)}</button>`
          )
          .join('')}
      </div>
    `;
    modalRoot.innerHTML = '';
    modalRoot.appendChild(modal);
    modalRoot.setAttribute('aria-hidden', 'false');

    const close = (result) => {
      modalRoot.setAttribute('aria-hidden', 'true');
      setTimeout(() => {
        modalRoot.innerHTML = '';
      }, 240);
      cleanup();
      resolve(result);
    };

    const collectValues = () => {
      const values = {};
      modal.querySelectorAll('[data-field]').forEach((el) => {
        values[el.dataset.field] = el.value;
      });
      return values;
    };

    const onClick = (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      close({ action: btn.dataset.action, values: collectValues() });
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        close(null);
      } else if (e.key === 'Enter' && defaultAction) {
        close({ action: defaultAction, values: collectValues() });
      }
    };

    modal.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);

    const cleanup = () => {
      document.removeEventListener('keydown', onKey);
    };

    // Autofocus first input
    requestAnimationFrame(() => {
      const focusable = modal.querySelector('[autofocus], input, select');
      focusable?.focus();
      if (focusable && focusable.select) focusable.select();
    });
  });
}

/* -------------------- Settings drawer -------------------- */

const drawerEl = document.getElementById('settings-drawer');
const drawerBody = document.getElementById('settings-body');

document.getElementById('settings-open').addEventListener('click', () => openSettings());
document.getElementById('settings-close').addEventListener('click', () => closeSettings());
drawerEl.querySelector('[data-close]').addEventListener('click', () => closeSettings());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerEl.getAttribute('aria-hidden') === 'false') {
    closeSettings();
  }
});

let _knownCameras = [];

async function openSettings() {
  await renderSettings();
  drawerEl.setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  drawerEl.setAttribute('aria-hidden', 'true');
}

async function renderSettings() {
  // Try to enumerate cameras; if labels are anonymous, prompt the user.
  try {
    _knownCameras = await listCameras();
  } catch {
    _knownCameras = [];
  }
  const camsHaveLabels = _knownCameras.some((c) => c.label);

  const storageStat = await getStorageEstimate();
  const usagePct = storageStat ? Math.min(100, Math.round(storageStat.ratio * 100)) : 0;
  const usageMB = storageStat ? (storageStat.usage / 1024 / 1024).toFixed(1) : '0.0';
  const quotaMB = storageStat ? (storageStat.quota / 1024 / 1024).toFixed(0) : '?';

  drawerBody.innerHTML = `
    <section class="settings-section">
      <div class="settings-section__title">Theme</div>
      <div class="theme-picker" id="theme-picker">
        <button class="theme-picker__opt ${settings.theme === 'dark' ? 'is-active' : ''}" data-theme="dark">
          <span class="theme-picker__swatch dark"></span>
          <span class="theme-picker__opt-label">Dark</span>
        </button>
        <button class="theme-picker__opt ${settings.theme === 'light' ? 'is-active' : ''}" data-theme="light">
          <span class="theme-picker__swatch light"></span>
          <span class="theme-picker__opt-label">Light</span>
        </button>
      </div>
    </section>

    <section class="settings-section">
      <div class="settings-section__title">Camera</div>
      ${
        camsHaveLabels
          ? `<select class="select" id="camera-select">
               ${_knownCameras
                 .map(
                   (c) =>
                     `<option value="${escapeHtml(c.deviceId)}" ${c.deviceId === settings.cameraDeviceId ? 'selected' : ''}>${escapeHtml(c.label)}</option>`
                 )
                 .join('')}
             </select>`
          : `<div class="settings-section__hint">Start the camera once to grant permission, then return here to choose between available cameras.</div>`
      }
    </section>

    <section class="settings-section">
      <div class="settings-section__title">Capture Quality</div>
      <select class="select" id="quality-select">
        <option value="low" ${settings.quality === 'low' ? 'selected' : ''}>Low — 854px wide, ~80KB / frame</option>
        <option value="med" ${settings.quality === 'med' ? 'selected' : ''}>Medium — 1280px wide, ~180KB / frame</option>
        <option value="high" ${settings.quality === 'high' ? 'selected' : ''}>High — 1920px wide, ~350KB / frame</option>
      </select>
      <div class="settings-section__hint">500 high-quality frames is roughly 175 MB. Lower the quality for longer sessions.</div>
    </section>

    <section class="settings-section">
      <div class="settings-section__title">Storage</div>
      <div class="storage-gauge">
        <div class="storage-gauge__bar">
          <div class="storage-gauge__fill ${usagePct > 80 ? 'is-warning' : ''}" style="width:${usagePct}%"></div>
        </div>
        <div class="storage-gauge__label">
          <span>${usageMB} MB used</span>
          <span>${quotaMB} MB quota</span>
        </div>
      </div>
      <div class="settings-section__hint">Captures are stored in your browser's IndexedDB. Clearing site data will erase them.</div>
    </section>

    <section class="settings-section">
      <div class="settings-section__title">About</div>
      <div class="settings-section__hint">
        Timelapse Capture · Local-first PWA<br/>
        For long sessions, keep this tab visible — browsers may pause background tabs.
      </div>
    </section>
  `;

  drawerBody.querySelector('#theme-picker').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme]');
    if (!btn) return;
    settings.theme = btn.dataset.theme;
    applyTheme();
    saveSettings();
    drawerBody.querySelectorAll('.theme-picker__opt').forEach((o) => {
      o.classList.toggle('is-active', o === btn);
    });
  });

  const camSelect = drawerBody.querySelector('#camera-select');
  if (camSelect) {
    camSelect.addEventListener('change', () => {
      settings.cameraDeviceId = camSelect.value;
      saveSettings();
      // Hot-swap the camera if capture view is active
      if (currentMode === 'capture') {
        onCaptureBecameVisible();
      }
    });
  }

  drawerBody.querySelector('#quality-select').addEventListener('change', (e) => {
    settings.quality = e.target.value;
    saveSettings();
  });
}

async function refreshStorageGauge() {
  // Re-render storage section if drawer is open
  if (drawerEl.getAttribute('aria-hidden') === 'false') {
    await renderSettings();
  }
}

/* -------------------- View switching -------------------- */

const viewRoot = document.getElementById('view-root');
const modeToggle = document.querySelector('.mode-toggle');
let currentMode = 'capture';
let _captureMounted = false;
let _playbackMounted = false;
let _captureRoot = null;
let _playbackRoot = null;

function ensureViewRoots() {
  if (!_captureRoot) {
    _captureRoot = document.createElement('div');
    _captureRoot.className = 'view';
    viewRoot.appendChild(_captureRoot);
  }
  if (!_playbackRoot) {
    _playbackRoot = document.createElement('div');
    _playbackRoot.className = 'view';
    viewRoot.appendChild(_playbackRoot);
  }
}

const sharedApi = {
  showModal,
  showToast,
  showProgressToast,
  refreshStorage: refreshStorageGauge,
  onCameraOpened: (cams, activeDeviceId) => {
    _knownCameras = cams;
    // Persist whichever device we ended up opening, so settings UI is correct.
    if (activeDeviceId && settings.cameraDeviceId !== activeDeviceId) {
      settings.cameraDeviceId = activeDeviceId;
      saveSettings();
    }
  },
  onSetCreated: () => {
    // If playback has been mounted, refresh its list so the new set shows up.
    if (_playbackMounted) {
      refreshSetList().catch(() => {});
    }
  },
};

async function switchMode(next) {
  if (next === currentMode) return;
  ensureViewRoots();

  // Hooks for current view
  if (currentMode === 'capture') onCaptureWillHide();
  if (currentMode === 'playback') onPlaybackWillHide();

  // Mount the target view if not yet
  if (next === 'capture' && !_captureMounted) {
    mountCapture(_captureRoot, settings, sharedApi);
    _captureMounted = true;
  }
  if (next === 'playback' && !_playbackMounted) {
    await mountPlayback(_playbackRoot, sharedApi);
    _playbackMounted = true;
  }

  // Toggle visibility
  _captureRoot.classList.toggle('is-active', next === 'capture');
  _playbackRoot.classList.toggle('is-active', next === 'playback');

  // Update mode toggle UI
  modeToggle.dataset.mode = next;
  modeToggle.querySelectorAll('.mode-toggle__btn').forEach((btn) => {
    const active = btn.dataset.mode === next;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });

  currentMode = next;

  // Hooks for new view
  if (next === 'capture') await onCaptureBecameVisible();
  if (next === 'playback') await onPlaybackBecameVisible();
}

modeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mode]');
  if (!btn) return;
  switchMode(btn.dataset.mode);
});

/* -------------------- Boot -------------------- */

applyTheme();
ensureViewRoots();
mountCapture(_captureRoot, settings, sharedApi);
_captureMounted = true;
_captureRoot.classList.add('is-active');
modeToggle.dataset.mode = 'capture';

// Tear down camera on page hide / unload to free hardware.
window.addEventListener('beforeunload', () => {
  teardownCapture();
});

// Service worker — only in production builds.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('SW registration failed', err);
    });
  });
}

/* -------------------- utils -------------------- */

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
