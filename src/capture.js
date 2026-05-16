/**
 * Capture session — timelapse loop.
 * Uses chained setTimeout (not setInterval) so we can recover gracefully
 * if a single capture takes longer than the interval. Also schedules the
 * NEXT capture relative to start time (drift-corrected).
 */

import { captureFrame } from './camera.js';
import { addFrame } from './db.js';

export class CaptureSession {
  constructor({ videoEl, intervalMs, plannedFrames, quality, onProgress, onComplete, onError }) {
    this.videoEl = videoEl;
    this.intervalMs = intervalMs;
    this.plannedFrames = plannedFrames;
    this.quality = quality;
    this.onProgress = onProgress || (() => {});
    this.onComplete = onComplete || (() => {});
    this.onError = onError || (() => {});

    this.setId = null;
    this.frameCount = 0;
    this.startedAt = null;
    this.timer = null;
    this.wakeLock = null;
    this.aborted = false;
  }

  async start(setId) {
    this.setId = setId;
    this.startedAt = performance.now();
    this.frameCount = 0;
    this.aborted = false;
    await this._requestWakeLock();
    // Take the first frame immediately, then schedule subsequent frames
    // at startedAt + N * interval.
    this._tick(0);
  }

  stop() {
    this.aborted = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this._releaseWakeLock();
  }

  async _tick(targetIndex) {
    if (this.aborted) return;
    try {
      const { blob, width, height } = await captureFrame(this.videoEl, this.quality);
      if (this.aborted) return;
      await addFrame(this.setId, this.frameCount, blob);
      this.frameCount += 1;

      this.onProgress({
        frame: this.frameCount,
        planned: this.plannedFrames,
        elapsedMs: performance.now() - this.startedAt,
        width,
        height,
      });

      if (this.frameCount >= this.plannedFrames) {
        this._releaseWakeLock();
        this.onComplete({
          frames: this.frameCount,
          width,
          height,
        });
        return;
      }
    } catch (err) {
      this.onError(err);
      this.stop();
      return;
    }

    // Drift-corrected scheduling: next capture should fire at
    // startedAt + (frameCount * interval), regardless of how long this
    // capture took. If we're already late, fire immediately.
    const nextTargetMs = (this.frameCount) * this.intervalMs;
    const elapsed = performance.now() - this.startedAt;
    const wait = Math.max(0, nextTargetMs - elapsed);
    this.timer = setTimeout(() => this._tick(this.frameCount), wait);
  }

  async _requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        // Re-acquire if released by visibility change
        this.wakeLock.addEventListener('release', () => {
          this.wakeLock = null;
        });
      }
    } catch (err) {
      // Non-fatal — capture works without wake lock, screen may sleep.
      console.warn('Wake lock failed:', err);
    }
  }

  _releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }
}
