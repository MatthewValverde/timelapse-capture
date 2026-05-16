# Timelapse Capture

**Live at:** [timelapse-capture](timelapse-capture.c24.airoapp.ai)

A browser-based timelapse capture app. Captures still frames from any connected
camera at a chosen interval, stores them locally in IndexedDB, and plays them
back with full scrubbing/speed control. Exports to WebM video or ZIP of
original JPEGs.

Local-first PWA — no server, no upload bandwidth, works offline once installed.

---

## Quick start

```bash
npm install
npm run dev
```

Open the printed URL (default `http://localhost:5173`). Camera access requires
either `localhost` or HTTPS, so plain `http://192.168.x.x` won't work — use
`http://localhost:5173` on the same machine, or set up HTTPS for LAN access.

For a production build:

```bash
npm run build       # outputs to dist/
npm run preview     # serves dist/ for testing
```

The service worker is only active in production builds (the dev server
disables it to avoid caching headaches during development).

---

## Architecture

```
src/
├── main.js          App shell, settings, view switching, modal/toast utils
├── styles.css       All styles — light + dark themes via CSS variables
├── camera.js        Device enumeration, getUserMedia, frame capture
├── capture.js       CaptureSession class — drift-corrected timelapse loop
├── captureView.js   Capture mode UI
├── playbackView.js  Playback mode UI
├── exporter.js      WebM (canvas + MediaRecorder) and ZIP exports
└── db.js            IndexedDB layer — sets and frames stores

public/
├── sw.js            Service worker (production only)
├── manifest.webmanifest
└── icon.svg / icon-maskable.svg
```

### Storage schema

IndexedDB database `timelapse-capture` (v1):

- **`sets`** (autoincrement key `id`) — `{ id, name, createdAt, interval,
  totalFrames, plannedFrames, cameraLabel, quality, width, height }`
- **`frames`** (composite key `[setId, index]`) — `{ setId, index, blob }`

Frames are stored as JPEG Blobs. Quality presets pick width + JPEG quality:

| Preset | Max width | Approx size / frame |
|--------|-----------|---------------------|
| Low    | 854px     | ~80 KB              |
| Medium | 1280px    | ~180 KB             |
| High   | 1920px    | ~350 KB             |

500 frames at High is roughly 175 MB. Browser quotas are typically 10% of
disk; the Storage section in Settings shows actual usage.

### Capture loop

`CaptureSession` uses chained `setTimeout` rather than `setInterval`, with
drift correction — each capture is scheduled relative to the session's
start time, so a slow capture doesn't push subsequent captures back. If a
capture is already late, the next fires immediately.

Wake Lock is requested on session start to prevent screen sleep on devices
that support it. Background tabs may still be throttled or paused by the
browser; the UI shows a hint about this.

### Video export

`exporter.exportToWebM` decodes all frames to ImageBitmaps, draws them
to a hidden canvas at the chosen FPS, and records the canvas's stream with
`MediaRecorder` (VP9 if available, else VP8). For 500 frames at medium
quality the peak memory is ~90 MB during encode, which is fine on desktop.
For very long sessions a streaming encoder (WebCodecs) would scale better
— happy to add that if needed.

---

## Browser support

- Chrome / Edge / Opera (desktop): full support
- Firefox: full support, MediaRecorder uses VP8 instead of VP9
- Safari: camera + IndexedDB work, but WebM export depends on Safari version
  — Safari has historically lagged on `MediaRecorder`. ZIP export always works.

---

## Roadmap / nice-to-haves

Things that aren't in v1 but would be reasonable additions:

- MP4 export via `ffmpeg.wasm` (~25 MB bundle cost)
- WebCodecs-based encoder for long sessions without the all-frames-in-memory step
- Per-set ghosting / onion-skin in capture mode for stop-motion
- Schedule-triggered capture ("start at 3pm")
- Sync to a remote bucket as a backup option
