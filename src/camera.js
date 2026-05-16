/**
 * Camera management
 * Handles device enumeration, getUserMedia, stream lifecycle.
 */

let _currentStream = null;

export async function listCameras() {
  // We need to get permission once before labels are populated.
  // If we haven't yet, enumerateDevices returns empty/anon labels.
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    throw new Error('mediaDevices API not available');
  }
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `Camera ${i + 1}`,
    }));
}

/**
 * Request a stream. If deviceId is provided, opens that exact camera.
 * Otherwise opens default camera (will prompt for permission).
 */
export async function openCamera(deviceId, { width = 1280, height = 720 } = {}) {
  await closeCamera();
  const constraints = {
    audio: false,
    video: deviceId
      ? {
          deviceId: { exact: deviceId },
          width: { ideal: width },
          height: { ideal: height },
        }
      : {
          width: { ideal: width },
          height: { ideal: height },
        },
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  _currentStream = stream;
  return stream;
}

export async function closeCamera() {
  if (_currentStream) {
    _currentStream.getTracks().forEach((t) => t.stop());
    _currentStream = null;
  }
}

export function getCurrentStream() {
  return _currentStream;
}

/**
 * Capture a single still from a video element to a Blob.
 * quality: 'low' | 'med' | 'high' — JPEG quality + downscale.
 */
export async function captureFrame(videoEl, quality = 'med') {
  if (!videoEl || !videoEl.videoWidth) {
    throw new Error('Video not ready');
  }

  const sw = videoEl.videoWidth;
  const sh = videoEl.videoHeight;

  // Quality presets — picked to keep IndexedDB usage reasonable
  // for 500 frames. Rough sizes: low ~80KB, med ~180KB, high ~350KB.
  const presets = {
    low: { maxW: 854, jpeg: 0.7 },
    med: { maxW: 1280, jpeg: 0.82 },
    high: { maxW: 1920, jpeg: 0.92 },
  };
  const { maxW, jpeg } = presets[quality] || presets.med;

  const scale = Math.min(1, maxW / sw);
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);

  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, dw, dh);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve({ blob, width: dw, height: dh });
        else reject(new Error('toBlob failed'));
      },
      'image/jpeg',
      jpeg
    );
  });
}
