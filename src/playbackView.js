/**
 * Playback view
 * Set list on the left, player on the right.
 * Player: image stage + scrubber + play/pause + speed pills + loop + export menu.
 */

import { listSets, getSet, getFrame, deleteSet, listFrames } from './db.js';
import { exportToWebM, exportToZip, downloadBlob, safeFilename } from './exporter.js';

let _api = null;

let _state = {
  sets: [],
  currentSet: null,
  frameCount: 0,
  frameIndex: 0,
  fps: 12,
  loop: true,
  playing: false,
  rafTimer: null,
  imgEl: null,
  // Memoize last-rendered frame URL so we can revoke it when swapping.
  currentObjectURL: null,
};

const SPEEDS = [6, 12, 24, 30, 60];

export async function mountPlayback(rootEl, api) {
  _api = api;

  rootEl.innerHTML = `
    <div class="playback">
      <aside class="playback__list" id="set-list">
        <div class="playback__list-head">
          <span class="playback__list-title">Capture Sets</span>
          <span class="playback__list-count" id="set-count">0</span>
        </div>
        <div id="set-list-body"></div>
      </aside>

      <section class="playback__player">
        <div class="player__stage" id="player-stage">
          <div class="player__stage-empty" id="player-empty">No set selected</div>
          <img id="player-img" alt="" style="display:none" />
          <div class="player__hud" id="player-hud" style="display:none">
            <span data-text>0 / 0</span>
          </div>
        </div>

        <div class="player__scrubber">
          <input class="range" id="scrubber" type="range" min="0" max="0" value="0" step="1" disabled />
        </div>

        <div class="player__controls">
          <div class="player__controls-left">
            <button class="play-btn" id="play-btn" disabled aria-label="Play">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" id="play-icon">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </button>
            <div class="speed-pill" id="speed-pill" role="group" aria-label="Speed">
              ${SPEEDS.map((s) => `<button data-fps="${s}" class="${s === 12 ? 'is-active' : ''}">${s}fps</button>`).join('')}
            </div>
            <button class="toggle-pill is-on" id="loop-toggle" aria-pressed="true">
              <span class="dot"></span>Loop
            </button>
          </div>
          <div></div>
          <div class="player__controls-right">
            <button class="action-btn" id="export-webm" disabled>Export WebM</button>
            <button class="action-btn" id="export-zip" disabled>Export ZIP</button>
            <button class="action-btn is-danger" id="delete-set" disabled>Delete</button>
          </div>
        </div>
      </section>
    </div>
  `;

  _state.imgEl = rootEl.querySelector('#player-img');

  // Wire scrubber
  const scrubber = rootEl.querySelector('#scrubber');
  scrubber.addEventListener('input', () => {
    if (!_state.currentSet) return;
    pause();
    seekTo(Number(scrubber.value));
  });

  // Play / pause
  rootEl.querySelector('#play-btn').addEventListener('click', () => {
    if (!_state.currentSet) return;
    if (_state.playing) pause();
    else play();
  });

  // Speed
  rootEl.querySelector('#speed-pill').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-fps]');
    if (!btn) return;
    const fps = Number(btn.dataset.fps);
    _state.fps = fps;
    rootEl.querySelectorAll('#speed-pill button').forEach((b) => {
      b.classList.toggle('is-active', Number(b.dataset.fps) === fps);
    });
  });

  // Loop toggle
  rootEl.querySelector('#loop-toggle').addEventListener('click', (e) => {
    _state.loop = !_state.loop;
    e.currentTarget.classList.toggle('is-on', _state.loop);
    e.currentTarget.setAttribute('aria-pressed', String(_state.loop));
  });

  // Export buttons
  rootEl.querySelector('#export-webm').addEventListener('click', () => exportWebM());
  rootEl.querySelector('#export-zip').addEventListener('click', () => exportZip());
  rootEl.querySelector('#delete-set').addEventListener('click', () => confirmDelete());

  await refreshList();
}

export async function onPlaybackBecameVisible() {
  await refreshList();
}

export function onPlaybackWillHide() {
  pause();
}

export async function refreshList() {
  _state.sets = await listSets();
  document.querySelector('#set-count').textContent = String(_state.sets.length);
  const body = document.querySelector('#set-list-body');
  if (_state.sets.length === 0) {
    body.innerHTML = `<div class="playback__list-empty">No capture sets yet.<br/>Switch to Capture mode to create one.</div>`;
    return;
  }

  body.innerHTML = _state.sets
    .map((s) => {
      const isActive = _state.currentSet && _state.currentSet.id === s.id;
      const dur = ((s.totalFrames * s.interval) / 1000).toFixed(0);
      return `
        <div class="set-card ${isActive ? 'is-active' : ''}" data-id="${s.id}">
          <div class="set-card__name">${escapeHtml(s.name)}</div>
          <div class="set-card__meta">
            <span>${s.totalFrames} frame${s.totalFrames === 1 ? '' : 's'}</span>
            <span>${(s.interval / 1000).toFixed(s.interval % 1000 ? 1 : 0)}s interval</span>
            <span>~${dur}s span</span>
          </div>
        </div>
      `;
    })
    .join('');

  body.querySelectorAll('.set-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = Number(card.dataset.id);
      loadSet(id);
    });
  });
}

async function loadSet(id) {
  pause();
  const set = await getSet(id);
  if (!set) return;

  _state.currentSet = set;
  _state.frameCount = set.totalFrames;
  _state.frameIndex = 0;

  // Mark active in list
  document.querySelectorAll('.set-card').forEach((c) => {
    c.classList.toggle('is-active', Number(c.dataset.id) === id);
  });

  // Show player
  document.querySelector('#player-empty').style.display = 'none';
  _state.imgEl.style.display = 'block';
  document.querySelector('#player-hud').style.display = 'block';

  const scrubber = document.querySelector('#scrubber');
  scrubber.disabled = false;
  scrubber.max = String(Math.max(0, _state.frameCount - 1));
  scrubber.value = '0';

  document.querySelector('#play-btn').disabled = _state.frameCount === 0;
  document.querySelector('#export-webm').disabled = _state.frameCount === 0;
  document.querySelector('#export-zip').disabled = _state.frameCount === 0;
  document.querySelector('#delete-set').disabled = false;

  await renderFrame(0);
}

async function renderFrame(idx) {
  if (!_state.currentSet) return;
  const blob = await getFrame(_state.currentSet.id, idx);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  _state.imgEl.src = url;
  if (_state.currentObjectURL) {
    URL.revokeObjectURL(_state.currentObjectURL);
  }
  _state.currentObjectURL = url;

  _state.frameIndex = idx;
  document.querySelector('#scrubber').value = String(idx);
  const hudText = document.querySelector('#player-hud [data-text]');
  hudText.textContent = `${idx + 1} / ${_state.frameCount}`;
}

function seekTo(idx) {
  renderFrame(idx);
}

function play() {
  if (!_state.currentSet || _state.frameCount === 0) return;
  // If we're at the end and not looping, restart from 0
  if (_state.frameIndex >= _state.frameCount - 1 && !_state.loop) {
    _state.frameIndex = 0;
  }

  _state.playing = true;
  setPlayIcon(true);

  let lastTickAt = performance.now();
  const tick = (now) => {
    if (!_state.playing) return;
    const elapsed = now - lastTickAt;
    const frameDur = 1000 / _state.fps;
    if (elapsed >= frameDur) {
      let next = _state.frameIndex + 1;
      if (next >= _state.frameCount) {
        if (_state.loop) {
          next = 0;
        } else {
          pause();
          return;
        }
      }
      renderFrame(next);
      lastTickAt = now;
    }
    _state.rafTimer = requestAnimationFrame(tick);
  };
  _state.rafTimer = requestAnimationFrame(tick);
}

function pause() {
  _state.playing = false;
  setPlayIcon(false);
  if (_state.rafTimer) {
    cancelAnimationFrame(_state.rafTimer);
    _state.rafTimer = null;
  }
}

function setPlayIcon(playing) {
  const icon = document.querySelector('#play-icon');
  if (!icon) return;
  icon.innerHTML = playing
    ? '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>'
    : '<path d="M8 5v14l11-7z"/>';
  document.querySelector('#play-btn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

/* -------------------- export & delete -------------------- */

async function exportWebM() {
  if (!_state.currentSet) return;
  pause();

  const fpsResult = await _api.showModal({
    title: 'Export to WebM',
    subtitle: `Choose frame rate. ${_state.frameCount} frames will become a ${'~'}${(_state.frameCount / 24).toFixed(1)}s video at 24fps.`,
    fields: [
      {
        id: 'fps',
        label: 'Frame rate',
        type: 'select',
        options: SPEEDS.map((s) => ({ value: String(s), label: `${s} fps` })),
        value: '24',
      },
    ],
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'ghost' },
      { id: 'export', label: 'Export', kind: 'primary' },
    ],
    defaultAction: 'export',
  });

  if (!fpsResult || fpsResult.action !== 'export') return;
  const fps = Number(fpsResult.values.fps) || 24;

  const dismiss = _api.showProgressToast('Encoding video — keep this tab open');
  try {
    const blob = await exportToWebM(_state.currentSet, fps, ({ done, total, phase }) => {
      dismiss.update(`${phase} ${done}/${total}`);
    });
    dismiss.close();
    downloadBlob(blob, safeFilename(_state.currentSet.name) + '.webm');
    _api.showToast('Video exported', 'success');
  } catch (err) {
    dismiss.close();
    console.error(err);
    _api.showToast('Export failed: ' + err.message, 'error');
  }
}

async function exportZip() {
  if (!_state.currentSet) return;
  pause();
  const dismiss = _api.showProgressToast('Packing ZIP…');
  try {
    const blob = await exportToZip(_state.currentSet, ({ done, total, phase }) => {
      dismiss.update(`${phase} ${Math.round(done)}/${Math.round(total)}`);
    });
    dismiss.close();
    downloadBlob(blob, safeFilename(_state.currentSet.name) + '.zip');
    _api.showToast('ZIP exported', 'success');
  } catch (err) {
    dismiss.close();
    console.error(err);
    _api.showToast('Export failed: ' + err.message, 'error');
  }
}

async function confirmDelete() {
  if (!_state.currentSet) return;
  const confirmed = await _api.showModal({
    title: 'Delete this set?',
    subtitle: `"${_state.currentSet.name}" — ${_state.frameCount} frames will be permanently deleted.`,
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'ghost' },
      { id: 'delete', label: 'Delete', kind: 'danger' },
    ],
  });
  if (!confirmed || confirmed.action !== 'delete') return;

  pause();
  const id = _state.currentSet.id;
  _state.currentSet = null;
  _state.frameCount = 0;
  _state.frameIndex = 0;

  await deleteSet(id);

  // Reset player UI
  _state.imgEl.style.display = 'none';
  _state.imgEl.src = '';
  if (_state.currentObjectURL) URL.revokeObjectURL(_state.currentObjectURL);
  _state.currentObjectURL = null;
  document.querySelector('#player-empty').style.display = 'block';
  document.querySelector('#player-hud').style.display = 'none';
  const scrubber = document.querySelector('#scrubber');
  scrubber.disabled = true;
  scrubber.value = '0';
  scrubber.max = '0';
  document.querySelector('#play-btn').disabled = true;
  document.querySelector('#export-webm').disabled = true;
  document.querySelector('#export-zip').disabled = true;
  document.querySelector('#delete-set').disabled = true;

  _api.showToast('Set deleted', 'success');
  _api.refreshStorage();
  await refreshList();
}

/* -------------------- utils -------------------- */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
