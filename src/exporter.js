/**
 * Exporters
 *  - WebM video: render each frame to a canvas, capture canvas as a
 *    MediaStream, record with MediaRecorder. FPS is user-supplied.
 *  - ZIP: pack original blobs with sequential names.
 */

import JSZip from 'jszip';
import { listFrames } from './db.js';

/**
 * Export a capture set to a WebM video Blob.
 * Returns a Blob; caller decides what to do with it.
 *
 * @param {object} set - the set record (has width/height, name)
 * @param {number} fps - target video frame rate
 * @param {(progress: {done: number, total: number}) => void} [onProgress]
 */
export async function exportToWebM(set, fps, onProgress) {
  const frames = await listFrames(set.id);
  if (frames.length === 0) throw new Error('No frames to export');

  // Decode all frames to ImageBitmaps first (fast random access).
  // For 500 frames at med quality this is ~90MB peak — acceptable.
  const bitmaps = [];
  for (let i = 0; i < frames.length; i++) {
    const bmp = await createImageBitmap(frames[i].blob);
    bitmaps.push(bmp);
    if (onProgress) onProgress({ done: i + 1, total: frames.length, phase: 'decoding' });
  }

  // Use the dimensions of the first frame to size the canvas.
  const width = bitmaps[0].width;
  const height = bitmaps[0].height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // Fill black so any sub-frame area is clean
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  const stream = canvas.captureStream(0); // manual frame mode
  const track = stream.getVideoTracks()[0];

  // Pick a supported mime type. VP9 if available, fall back to VP8.
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  if (!mime) throw new Error('No supported WebM codec available');

  const chunks = [];
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 8_000_000,
  });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = resolve;
    recorder.onerror = (e) => reject(e.error || new Error('Recorder error'));
  });

  recorder.start();

  const frameDurMs = 1000 / fps;

  for (let i = 0; i < bitmaps.length; i++) {
    ctx.drawImage(bitmaps[i], 0, 0, width, height);
    // requestFrame is a hint to the captureStream to produce a frame.
    if (typeof track.requestFrame === 'function') {
      track.requestFrame();
    }
    if (onProgress) onProgress({ done: i + 1, total: bitmaps.length, phase: 'encoding' });
    await sleep(frameDurMs);
  }

  // Hold the last frame briefly so it isn't truncated.
  await sleep(frameDurMs * 2);

  recorder.stop();
  await stopped;

  // Clean up
  bitmaps.forEach((b) => b.close && b.close());
  track.stop();

  return new Blob(chunks, { type: mime });
}

/**
 * Export all frames as a ZIP archive containing original JPEGs
 * named 0001.jpg, 0002.jpg, ... plus a metadata.json.
 */
export async function exportToZip(set, onProgress) {
  const frames = await listFrames(set.id);
  if (frames.length === 0) throw new Error('No frames to export');

  const zip = new JSZip();
  const folder = zip.folder(safeFilename(set.name));

  // Metadata
  folder.file(
    'metadata.json',
    JSON.stringify(
      {
        name: set.name,
        createdAt: new Date(set.createdAt).toISOString(),
        intervalMs: set.interval,
        plannedFrames: set.plannedFrames,
        totalFrames: set.totalFrames,
        cameraLabel: set.cameraLabel,
        quality: set.quality,
        width: set.width,
        height: set.height,
      },
      null,
      2
    )
  );

  const pad = String(frames.length).length;
  for (let i = 0; i < frames.length; i++) {
    const name = String(frames[i].index).padStart(Math.max(4, pad), '0') + '.jpg';
    folder.file(name, frames[i].blob);
    if (onProgress) onProgress({ done: i + 1, total: frames.length, phase: 'packing' });
  }

  return zip.generateAsync(
    { type: 'blob', compression: 'STORE' }, // JPEGs don't compress, skip overhead
    (meta) => onProgress && onProgress({ done: meta.percent, total: 100, phase: 'zipping' })
  );
}

/* ---------- helpers ---------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function safeFilename(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
