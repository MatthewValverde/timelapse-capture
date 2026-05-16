/**
 * Capture view
 * Renders the capture UI: live preview, interval + count controls, start/stop.
 */

import { listCameras, openCamera, closeCamera, getCurrentStream } from './camera.js';
import { CaptureSession } from './capture.js';
import { createSet, updateSet, deleteSet } from './db.js';

let _state = {
  videoEl: null,
  intervalSec: 5,
  plannedFrames: 60,
  session: null,
  cameraOpen: false,
  cameraDeviceId: null,
};

let _settings = null; // injected
let _api = null;      // injected (showModal, showToast, refreshStorage)

export function mountCapture(rootEl, settings, api) {
  _settings = settings;
  _api = api;

  rootEl.innerHTML = `
    <div class="capture">
      <div class="capture__stage" data-empty="true">
        <div class="capture__placeholder" id="capture-placeholder">
          <div class="capture__placeholder-inner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
              <circle cx="12" cy="13" r="4"></circle>
            </svg>
            <p>Camera not started</p>
            <button class="btn btn--primary" id="cam-start">Start Camera</button>
          </div>
        </div>
        <video id="capture-video" autoplay playsinline muted style="display:none"></video>
        <div class="capture__hud" id="capture-hud" style="display:none">
          <div class="hud-row">
            <span class="hud-tag" id="hud-camera"><span class="dot"></span><span data-text>Camera</span></span>
            <span class="hud-tag" id="hud-status" style="display:none"><span class="dot"></span><span data-text>READY</span></span>
          </div>
          <div class="hud-row">
            <span class="hud-tag" id="hud-frames" style="display:none">FRAMES <span data-text>0 / 0</span></span>
            <span class="hud-tag" id="hud-eta" style="display:none">ETA <span data-text>--:--</span></span>
          </div>
        </div>
        <div class="capture__flash" id="capture-flash"></div>
      </div>

      <div class="capture__progress" id="cap-progress">
        <div class="capture__progress-fill" id="cap-progress-fill"></div>
      </div>

      <div class="capture__controls">
        <div class="control-group">
          <div class="control-group__label">
            <span>Interval</span>
            <span><span class="control-group__value" id="lbl-interval">5</span><span class="control-group__value-secondary">sec</span></span>
          </div>
          <input class="range" id="ctrl-interval" type="range" min="1" max="300" value="5" step="1" />
        </div>

        <div class="control-group">
          <div class="control-group__label">
            <span>Captures</span>
            <span>
              <span class="control-group__value" id="lbl-count">60</span>
              <input class="numfield" id="ctrl-count-num" type="number" min="1" max="500" value="60" style="display:none" />
            </span>
          </div>
          <input class="range" id="ctrl-count" type="range" min="1" max="500" value="60" step="1" />
        </div>

        <button class="cap-btn" id="cap-go" disabled>
          <span class="cap-btn__indicator"></span>
          <span data-text>Start Capture</span>
        </button>
      </div>
    </div>
  `;

  _state.videoEl = rootEl.querySelector('#capture-video');

  // Wire controls
  const intervalEl = rootEl.querySelector('#ctrl-interval');
  const intervalLbl = rootEl.querySelector('#lbl-interval');
  intervalEl.addEventListener('input', () => {
    _state.intervalSec = Number(intervalEl.value);
    intervalLbl.textContent = _state.intervalSec;
    updateEta();
  });

  const countEl = rootEl.querySelector('#ctrl-count');
  const countLbl = rootEl.querySelector('#lbl-count');
  countEl.addEventListener('input', () => {
    _state.plannedFrames = Number(countEl.value);
    countLbl.textContent = _state.plannedFrames;
    updateEta();
  });

  // Allow clicking the count label to type a number directly
  const countNumEl = rootEl.querySelector('#ctrl-count-num');
  countLbl.addEventListener('click', () => {
    countLbl.style.display = 'none';
    countNumEl.style.display = 'inline-block';
    countNumEl.value = _state.plannedFrames;
    countNumEl.focus();
    countNumEl.select();
  });
  const commitNum = () => {
    let v = parseInt(countNumEl.value, 10);
    if (Number.isNaN(v) || v < 1) v = 1;
    if (v > 500) v = 500;
    _state.plannedFrames = v;
    countLbl.textContent = v;
    countEl.value = v;
    countNumEl.style.display = 'none';
    countLbl.style.display = 'inline';
    updateEta();
  };
  countNumEl.addEventListener('blur', commitNum);
  countNumEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitNum();
  });

  // Start camera button
  rootEl.querySelector('#cam-start').addEventListener('click', () => startCamera());

  // Capture button
  rootEl.querySelector('#cap-go').addEventListener('click', () => {
    if (_state.session) {
      stopSession();
    } else {
      startSession();
    }
  });

  updateEta();
}

export async function onCaptureBecameVisible() {
  // Don't disturb an active capture. The camera change will take effect
  // the next time we open the view.
  if (_state.session) {
    if (_api && _state.cameraDeviceId !== _settings.cameraDeviceId) {
      _api.showToast('Camera change will apply after this capture', 'info');
    }
    return;
  }
  // If user changed camera in settings, reopen.
  if (_state.cameraOpen && _state.cameraDeviceId !== _settings.cameraDeviceId) {
    await startCamera();
  }
}

export function onCaptureWillHide() {
  // Don't tear down camera when switching to playback — keeps it warm.
  // But stop any active session.
  if (_state.session) {
    stopSession({ silent: true });
  }
}

export async function teardownCapture() {
  if (_state.session) _state.session.stop();
  await closeCamera();
  _state.cameraOpen = false;
}

/* -------------------------- camera -------------------------- */

async function startCamera() {
  try {
    // First call may need permission — without permission, device labels are blank.
    // Trigger a default request first if we haven't enumerated.
    let cams = await listCameras();
    let anonLabels = cams.length === 0 || cams.every((c) => !c.label);
    if (anonLabels) {
      // Open default camera briefly to provoke the permission prompt,
      // then re-enumerate to get labels.
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      tmp.getTracks().forEach((t) => t.stop());
      cams = await listCameras();
    }

    // If user has a saved deviceId that's still available, use it. Otherwise
    // pick the first.
    let deviceId = _settings.cameraDeviceId;
    if (!cams.find((c) => c.deviceId === deviceId)) {
      deviceId = cams[0]?.deviceId || null;
    }

    const stream = await openCamera(deviceId);
    _state.videoEl.srcObject = stream;
    _state.videoEl.style.display = 'block';
    _state.cameraOpen = true;
    _state.cameraDeviceId = deviceId;

    document.querySelector('.capture__stage').setAttribute('data-empty', 'false');
    document.querySelector('#capture-placeholder').style.display = 'none';
    document.querySelector('#capture-hud').style.display = 'flex';
    document.querySelector('#cap-go').disabled = false;

    // HUD camera label
    const camLabel = cams.find((c) => c.deviceId === deviceId)?.label || 'Camera';
    const hudCam = document.querySelector('#hud-camera [data-text]');
    hudCam.textContent = truncate(camLabel, 24);

    // Notify settings code so the camera dropdown reflects current selection.
    _api.onCameraOpened(cams, deviceId);
  } catch (err) {
    console.error(err);
    _api.showToast('Could not open camera: ' + err.message, 'error');
  }
}

/* -------------------------- session -------------------------- */

async function startSession() {
  if (!_state.cameraOpen) return;
  if (_state.intervalSec < 1 || _state.plannedFrames < 1) return;

  // Create the set record up-front (with a temp name) so frames stream to DB.
  const cams = await listCameras();
  const camLabel = cams.find((c) => c.deviceId === _state.cameraDeviceId)?.label || 'Camera';

  const set = await createSet({
    name: '__pending__',
    interval: _state.intervalSec * 1000,
    plannedFrames: _state.plannedFrames,
    cameraLabel: camLabel,
    quality: _settings.quality,
    width: _state.videoEl.videoWidth,
    height: _state.videoEl.videoHeight,
  });

  _state.session = new CaptureSession({
    videoEl: _state.videoEl,
    intervalMs: _state.intervalSec * 1000,
    plannedFrames: _state.plannedFrames,
    quality: _settings.quality,
    onProgress: ({ frame, planned, elapsedMs }) => {
      flashStage();
      const pct = (frame / planned) * 100;
      document.querySelector('#cap-progress-fill').style.width = pct + '%';
      const hudFrames = document.querySelector('#hud-frames [data-text]');
      hudFrames.textContent = `${frame} / ${planned}`;
      const remaining = planned - frame;
      const etaMs = remaining * _state.intervalSec * 1000;
      document.querySelector('#hud-eta [data-text]').textContent = formatDuration(etaMs);
    },
    onComplete: () => finalizeSession(set, false),
    onError: (err) => {
      _api.showToast('Capture error: ' + err.message, 'error');
      finalizeSession(set, true);
    },
  });

  // UI: switch to recording state
  setRecordingUI(true);
  await _state.session.start(set.id);
}

async function stopSession({ silent } = {}) {
  if (!_state.session) return;
  _state.session.stop();
  const setId = _state.session.setId;
  const frameCount = _state.session.frameCount;
  _state.session = null;

  if (silent) {
    // Cleanup pending set if frames captured > 0, otherwise discard.
    if (frameCount > 0) {
      await promptNameAndSave(setId, frameCount);
    } else {
      await deleteSet(setId);
    }
    setRecordingUI(false);
    return;
  }

  if (frameCount === 0) {
    await deleteSet(setId);
    _api.showToast('No frames captured — discarded', 'error');
    setRecordingUI(false);
    return;
  }

  await promptNameAndSave(setId, frameCount);
  setRecordingUI(false);
}

async function finalizeSession(set, errored) {
  const session = _state.session;
  _state.session = null;
  const frameCount = session ? session.frameCount : 0;

  if (frameCount === 0) {
    await deleteSet(set.id);
    setRecordingUI(false);
    if (!errored) _api.showToast('No frames captured', 'error');
    return;
  }

  await promptNameAndSave(set.id, frameCount);
  setRecordingUI(false);
}

async function promptNameAndSave(setId, frameCount) {
  const datePart = formatDateStamp(new Date());
  const defaultName = `Capture ${frameCount} frames`;

  const result = await _api.showModal({
    title: 'Save capture set',
    subtitle: `${frameCount} frame${frameCount === 1 ? '' : 's'} captured. The current date will be appended automatically.`,
    fields: [{ id: 'name', label: 'Name', placeholder: defaultName, value: '', autofocus: true }],
    actions: [
      { id: 'discard', label: 'Discard', kind: 'danger' },
      { id: 'save', label: 'Save', kind: 'primary' },
    ],
    defaultAction: 'save',
  });

  if (!result || result.action === 'discard') {
    if (result && result.action === 'discard') {
      const confirmed = await _api.showModal({
        title: 'Discard this capture?',
        subtitle: `${frameCount} frame${frameCount === 1 ? '' : 's'} will be permanently deleted.`,
        actions: [
          { id: 'keep', label: 'Keep', kind: 'ghost' },
          { id: 'discard', label: 'Discard', kind: 'danger' },
        ],
      });
      if (!confirmed || confirmed.action !== 'discard') {
        // re-prompt for name
        return promptNameAndSave(setId, frameCount);
      }
    }
    await deleteSet(setId);
    _api.showToast('Capture discarded', 'error');
    _api.refreshStorage();
    return;
  }

  const baseName = (result.values.name || '').trim() || defaultName;
  const finalName = `${baseName} · ${datePart}`;
  await updateSet(setId, { name: finalName });
  _api.showToast('Saved as ' + finalName, 'success');
  _api.refreshStorage();
  _api.onSetCreated();
}

/* -------------------------- ui helpers -------------------------- */

function setRecordingUI(recording) {
  const capBtn = document.querySelector('#cap-go');
  const capBtnText = capBtn.querySelector('[data-text]');
  const progress = document.querySelector('#cap-progress');
  const fill = document.querySelector('#cap-progress-fill');
  const hudStatus = document.querySelector('#hud-status');
  const hudStatusText = hudStatus.querySelector('[data-text]');
  const hudFrames = document.querySelector('#hud-frames');
  const hudEta = document.querySelector('#hud-eta');

  if (recording) {
    capBtn.classList.add('is-recording');
    capBtnText.textContent = 'Stop';
    progress.classList.add('is-recording');
    hudStatus.style.display = 'inline-flex';
    hudStatus.classList.add('is-rec');
    hudStatusText.textContent = 'REC';
    hudFrames.style.display = 'inline-flex';
    hudEta.style.display = 'inline-flex';
    // Disable controls during recording
    document.querySelector('#ctrl-interval').disabled = true;
    document.querySelector('#ctrl-count').disabled = true;
  } else {
    capBtn.classList.remove('is-recording');
    capBtnText.textContent = 'Start Capture';
    progress.classList.remove('is-recording');
    fill.style.width = '0%';
    hudStatus.style.display = 'none';
    hudStatus.classList.remove('is-rec');
    hudFrames.style.display = 'none';
    hudEta.style.display = 'none';
    document.querySelector('#ctrl-interval').disabled = false;
    document.querySelector('#ctrl-count').disabled = false;
  }
}

function flashStage() {
  const flash = document.querySelector('#capture-flash');
  if (!flash) return;
  flash.classList.add('is-flashing');
  setTimeout(() => flash.classList.remove('is-flashing'), 60);
}

function updateEta() {
  // Could surface a "total duration" estimate in the UI;
  // currently we just compute and could show it next to controls.
  // Left as a hook for future tweaks.
}

/* -------------------------- utils -------------------------- */

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDateStamp(d) {
  // YYYY-MM-DD format — sortable, unambiguous, filename-safe.
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}
