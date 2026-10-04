# Anchor Stabilizer — Design

A browser tool that removes camera drift from a video by pinning one or more user-chosen,
static "anchors" (a fencepost, a rock, a window corner) to the position they had in a reference
frame. Everything runs client-side, so the app is a static site that can be hosted on GitHub Pages
and the video never leaves the user's machine.

## Core principle

Every frame is aligned to the anchor's appearance in the **reference frame** (or the most recent
user correction), never chained frame-to-frame. Chaining accumulates small per-frame errors into a
random walk — the tool would *introduce* drift. Frame-to-frame motion is used only to predict
where to search.

## Building blocks

| Need | Library | License |
|---|---|---|
| Demux / decode / encode / mux (MP4, MOV, WebM, …), frame-exact access, audio passthrough | [Mediabunny](https://mediabunny.dev/) (WebCodecs, hardware accelerated) | MPL-2.0 |
| Template matching, ECC sub-pixel alignment | [OpenCV.js](https://docs.opencv.org/) via [`@techstark/opencv-js`](https://github.com/TechStark/opencv-js) | Apache-2.0 |
| UI | Svelte 5 + Vite + TypeScript | MIT |
| Hosting | GitHub Actions → GitHub Pages | — |

Rejected: ffmpeg.wasm + libvidstab (smooths global motion, cannot pin a chosen point; ~30 MB
software codec; the multithreaded build needs COOP/COEP headers GitHub Pages cannot send),
`<video>` seeking (not frame-accurate), jsfeat / tracking.js (unmaintained).

Nothing in the app requires `SharedArrayBuffer`, so no cross-origin-isolation headers are needed.

OpenCV.js is a UMD bundle whose CommonJS export is a promise; bundler CommonJS interop mangles that
promise, so the file is shipped as a static asset and evaluated in the tracking worker with a
minimal CommonJS shim (`tracker.worker.ts`). It is only downloaded when tracking starts.

## Pipeline

```
Load:     File → Mediabunny Input → frame timestamp list (packet metadata only, no decoding)

Pass 1 — Track (Web Worker: tracker.worker.ts)
          Mediabunny CanvasSink (hardware decode, display orientation)
          → read back only a search window around each anchor
          → OpenCV.js: NCC template match (coarse) → ECC alignment (sub-pixel, optional rotation)
          → per-frame anchor observations, streamed back to the UI

Solve (main thread, pure TS): observations → per-frame camera transform M_t (reference → frame)
          → gap filling, optional jitter filter → auto-crop rectangle

Pass 2 — Export (Web Worker: export.worker.ts)
          Mediabunny VideoSampleSink (decoder chosen so frames expose YUV planes at full bit depth)
          → WebGL2 Lanczos-3 warp per plane in stored orientation (gpuWarp.ts)
          → WebCodecs VideoEncoder, configured by encoderPlan.ts → Mediabunny muxer, same container;
          audio packets copied bit-exact
```

Frames are streamed, never accumulated: between passes only a few numbers per frame are kept.

## Tracking (per anchor, per frame) — `src/lib/tracking/anchorTracker.ts`

1. **Predict** the position from the last good observation plus damped velocity, and the rotation
   from the previous frame's camera estimate.
2. **Coarse**: normalized cross-correlation (`matchTemplate`, `TM_CCOEFF_NORMED`) of the template
   (pre-rotated by the predicted angle) inside a search window around the prediction.
3. **Fine**: ECC (`findTransformECC`, translation or Euclidean motion) initialised from the coarse
   result → sub-pixel position and patch rotation. Falls back to a parabolic peak fit if ECC fails or
   disagrees with the coarse match.
4. **Confidence** = correlation score (default threshold 0.8). Below the threshold the observation
   is excluded from the solve and shown amber/red on the timeline. While lost, the search window
   grows; after several lost frames a coarse whole-frame search re-acquires the anchor. Matches far
   from the prediction need a higher score (halfway to 1): NCC can latch onto strong edges, such as
   the corner of something passing in front of the anchor, with moderate scores.

Large anchors are tracked on a down-scaled copy (max side ≈ 160 px) to bound cost.

**Corrections**: dragging an anchor on any frame creates a keyframe. During tracking the keyframe
position is first refined against the current template (so a slightly imprecise drag is snapped
to the true position), then a fresh template is taken from that frame. The pinned target stays the
original reference position. Tracking is causal, so a re-track starts at the earliest changed
keyframe instead of frame 0.

## Solving the camera transform — `src/lib/geometry/`

* 1 anchor, position only → translation.
* 1 anchor + rotation → translation + the anchor patch's ECC rotation.
* 2+ anchors + rotation → weighted least-squares similarity (translation, roll, zoom). Frames with a
  single usable anchor borrow rotation/zoom from neighbouring frames.
* Frames with no usable anchor are interpolated (held at the ends).
* Optional Gaussian jitter filter on the parameters (off by default).
* Transforms are keyed by frame timestamp, not frame index assumptions (phones record VFR).

## Output framing — `src/lib/geometry/crop.ts`

Pinning exposes empty edges. The tool computes the largest rectangle with the source aspect ratio
that is covered in every stabilized frame (a concave maximisation solved by nested ternary search)
and scales it to the source resolution. The user can choose any zoom between 1× (no crop) and that
auto value, and how uncovered areas are filled: black, or pixels from earlier frames
("history" — effective for static scenes).

## Export fidelity — `src/lib/media/export.worker.ts`, `encoderPlan.ts`, `src/lib/render/gpuWarp.ts`

Goal: the only change to the video is the stabilizing warp. Measured on a colour, high-detail
fixture (`e2e/quality.spec.ts`), the previous canvas-based pipeline reached 42 dB luma PSNR on the
unwarped reference frame; this one reaches 53 dB (H.264) and 64 dB (10-bit VP9), and stabilized
frames are within ~0.7 dB of an ideal reference warp of the source without re-encoding.

* **Decoding**: hardware first, software if the hardware path hides the planes (Chrome returns
  opaque frames for 10-bit hardware decodes) or reduces bit depth. Frames are processed in stored
  orientation; the output keeps the source's rotation/flip metadata.
* **Warp**: per plane on the GPU at native bit depth (integer textures), Lanczos-3, chroma siting
  respected (left-co-sited horizontally, centred vertically). Output is packed four 8-bit or two
  16-bit samples per RGBA8 texel so the read-back is exactly the plane data. Uncovered areas are
  black (in the source's range) or the previous output frame. If a browser only provides RGB frames
  (Firefox) or opaque frames, the warp runs in RGB and converts to YUV with the source's matrix.
* **Encoding**: WebCodecs is driven directly (Mediabunny only muxes) to use per-frame quantizers.
  The planner tries the source codec string, then generic strings, at the source bit depth, then 8
  bits, then other codecs; for each it checks `isConfigSupported` *and* probes that the quality
  setting actually changes the output (Firefox accepts but ignores quantizers, and bitrates for
  VP9/AV1). Quantizers were calibrated per codec (H.264 8, HEVC 7, VP9 1, AV1 2 by default).
  Keyframes are placed where the source has them; frame timestamps and durations are copied; the
  output colour space (and MP4 `colr` box) is the source's.
* **Container and audio**: same container as the source unless the codec had to change and does not
  fit (WebM → Matroska); audio packets and metadata tags are copied unchanged.

## UI flow

1. **Open** — drag & drop or pick a file.
2. **Anchor** — frame-accurate scrubbing; choose the reference frame; draw boxes (a loupe shows the
   area under the pointer magnified).
3. **Track** — progress with live overlay; confidence strip on the timeline; click red regions to
   jump there and fix them.
4. **Preview** — original / stabilized toggle; playback; zoom and edge-fill settings.
5. **Export** — same encoding as the source (see *Export fidelity*), audio copied. On Chromium the
   file streams straight to disk (File System Access API), elsewhere it downloads from memory. Project (anchors, corrections,
   tracking data) can be saved/loaded as JSON.

Keyboard: Space play/pause, ←/→ frame step, Shift+←/→ 10 frames, Home/End, Delete removes the
selected anchor.

## Code layout

```
src/
  lib/geometry/   affine math, similarity fit, trajectory solve, crop solver (pure TS, unit-tested)
  lib/tracking/   OpenCV.js anchor tracker (environment-agnostic), tracking worker
  lib/media/      Mediabunny helpers: open video, frame list, preview player, export worker
  lib/render/     drawing a frame through a stabilization matrix
  lib/state/      app state (Svelte runes), project save/load
  components/     Svelte UI
tests/            Vitest: geometry + tracker accuracy on synthetic drifting frames (runs in Node)
e2e/              Playwright: load → anchor → track → export on a generated drifting video
```

## Verification

* Unit tests (Node, real OpenCV.js): tracking accuracy on synthetic drifting/rolling frames with known
  ground truth (< 0.15 px translation, < 0.25 px with roll), occlusion and re-acquisition, corrections,
  large anchors, mid-clip resume; geometry and crop solver.
* End-to-end (Playwright, Chrome and Firefox): ffmpeg-encoded fixture with known motion → UI → tracking
  error ≈ 0.1 px; residual motion in the exported MP4 ≈ 0.1–0.15 px; occlusion flagging, corrections
  and partial re-track; portrait video with rotation metadata.
* Throughput (Chrome, Apple Silicon): tracking two anchors with rotation ≈ 39 fps at 1080p and
  ≈ 26 fps at 4K; export ≈ 33 fps at both.

## Limitations

* Pinning is exact for camera *rotation* (typical handheld drift). If the camera translates,
  only the depth plane of the anchors is pinned (parallax).
* Large drift ⇒ large crop (or uncovered edges).
* HEVC decode depends on browser + hardware. HDR survives only where the browser exposes the
  10-bit planes and can encode 10-bit (e.g. VP9 in Chrome); Chrome's 10-bit HEVC goes through 8-bit
  RGB and is exported as SDR.
* Re-encoding cannot be literally lossless except for VP9 at *Maximum*; files are larger than the
  original.
* OpenCV.js is ~13 MB on first load (cached afterwards).
* Rolling-shutter wobble and lens distortion are not corrected.
* Preview playback is silent; audio is preserved in the export.

## Future work

Perspective (homography) model with 4+ anchors; "smooth" mode (partial lock); ML point tracker
(e.g. CoTracker via onnxruntime-web) for hard cases; trimmed OpenCV.js build.
