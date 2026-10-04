# Anchor Stabilizer

Stabilize drifting video in your browser by pinning a point that should never move.

Shot a landscape on your phone and the framing slowly wandered? Mark a fencepost, a rock, or the
corner of a building, and every frame is shifted (and optionally rotated) so that detail stays exactly
where it was in the reference frame. Everything runs locally in the browser — the video is never
uploaded — so the app is a static site that can be hosted on GitHub Pages.

## Using it

1. **Open** a video (MP4, MOV or WebM) by dropping it on the page.
2. **Anchor**: on the reference frame (the first frame by default), drag a box around something static
   with some texture or edges. Add a second anchor far from the first and choose
   *Position + rotation* to remove roll and zoom as well.
3. **Track**: every frame is matched against the reference, with sub-pixel accuracy. Frames where an
   anchor wasn't found confidently are shown amber/red on the timeline; *Next issue* jumps to them.
   Drag the anchor on such a frame to correct it, then *Re-track* from there.
4. **Framing**: pinning exposes empty edges. By default the video is cropped to the largest view
   without them; or choose a smaller zoom and fill the edges with black or with pixels from earlier
   frames (good for still scenes). An optional jitter filter smooths the result.
5. **Export**. The result is encoded like the original: same codec (and codec profile string), bit
   depth, container, colour tags, rotation metadata, frame timestamps and keyframe positions, with
   the audio and metadata tags copied untouched. Re-encoding is effectively lossless by default (see
   below). In Chrome/Edge the file is written straight to disk; elsewhere it downloads when done.

Projects (anchors, corrections and tracking results) can be saved and reloaded as JSON.

Keyboard: <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> step a frame (<kbd>Shift</kbd> for
10) · <kbd>Home</kbd>/<kbd>End</kbd> · <kbd>V</kbd> toggle original/stabilized · <kbd>Delete</kbd>
remove the selected anchor or correction.

### Export quality

Stabilizing requires re-encoding, so the export is built to lose as little as possible:

* **No colour round trip**: frames are warped directly on their YUV planes at native bit depth
  (8, 10 or 12 bit) on the GPU, never through an 8-bit RGB canvas.
* **Sharp resampling**: a Lanczos-3 kernel instead of the browser's bilinear filter; an exact
  identity transform reproduces pixels unchanged.
* **Constant-quality encoding**, calibrated per codec. *Visually lossless* (default) measures about
  51–53 dB luma PSNR against the decoded source on a high-detail test video, well under one code
  value of error. *Maximum* goes further (VP9 becomes mathematically lossless); *Smaller file* trades
  a little quality for size. Expect files larger than the original: the original's compression
  artefacts must be preserved too.
* Encoders that silently ignore quality settings (Firefox does, for quantizers and for VP9/AV1
  bitrates) are detected with a probe encode, and a high bitrate or another codec is used instead.

The export summary lists exactly what was produced and any deviation from the source, for example:

| Situation | What happens |
|---|---|
| Chrome, H.264 / HEVC / VP9 / AV1 source | Same codec and bit depth, constant quality, YUV processing |
| Firefox (decodes to RGB only) | Same codec where its quality can be controlled (H.264); colour passes through 8-bit RGB (≈ 50 dB) |
| Firefox, VP9/AV1 source | H.264 in Matroska, because Firefox ignores VP9/AV1 quality settings |
| 10-bit HEVC (iPhone HDR) in Chrome | Chrome only exposes such frames as 8-bit RGB and cannot encode 10-bit HEVC: 8-bit SDR output |

Upscaling the crop back to the original size softens fine detail by the zoom factor. Choose
**Output size → Cropped area at native resolution** in Framing to keep pixels 1:1.

### Browser support

Requires WebCodecs and WebGL2. Tested in current Google Chrome and Firefox (both on macOS); current
Edge and Safari should work but have not been tested. Chrome gives the best export fidelity. HEVC
(the iPhone default) only decodes where the browser and hardware support it — Safari, or Chrome on
recent Macs/PCs.

### Limitations

* Pinning is exact for camera **rotation** (the usual handheld drift). If the camera physically moves,
  only things at the anchor's distance stay pinned (parallax).
* Large drift means a large crop (or uncovered edges).
* Rolling-shutter wobble and lens distortion are not corrected. Preview playback is silent.

## How it works

See [docs/DESIGN.md](docs/DESIGN.md). In short:

* [Mediabunny](https://mediabunny.dev/) reads, decodes (WebCodecs, hardware accelerated), encodes and
  writes the video, including frame-exact access and audio passthrough.
* [OpenCV.js](https://docs.opencv.org/) finds each anchor in each frame in a Web Worker: normalized
  cross-correlation for a coarse match, then ECC alignment for sub-pixel position and rotation. Every
  frame is matched against the reference appearance, so tracking errors never accumulate into drift.
* The per-anchor positions are turned into one camera transform per frame (translation, or a
  similarity with rotation and zoom), and each frame is drawn through its inverse.

## Development

Requires Node.js 22+.

```sh
npm install
npm run dev        # http://localhost:5173
npm run check      # type-check app, tests and configs
npm test           # unit tests: geometry and tracker accuracy on synthetic video (Node)
npm run test:e2e   # end-to-end in Google Chrome; needs ffmpeg and Chrome installed
npm run test:cross # also Firefox/WebKit (npx playwright install firefox webkit)
npm run test:perf  # 1080p and 4K throughput
npm run build      # static site in dist/
```

The end-to-end tests render a scene seen by a drifting, rolling camera with known ground truth,
encode it with ffmpeg, drive the UI (anchors, tracking, corrections, export), and check tracking
accuracy (≈0.1 px), the residual motion in the exported file (≈0.1–0.15 px), and export fidelity:
codec, bit depth, colour tags, timestamps and bit-identical audio must match the source, and PSNR
against the source must stay above the lossless thresholds (8-bit H.264 and 10-bit VP9).

## Deploying to GitHub Pages

The workflow in `.github/workflows/deploy.yml` runs type checks, unit tests and the build on every
push and pull request, and deploys `dist/` to GitHub Pages on pushes to `main`. The browser
end-to-end tests run as a separate job that reports results without blocking the deploy, since they
depend on the video codecs of GitHub's (hardware-encoder-less) Linux runners. In the repository
settings, set **Pages → Build and deployment → Source** to **GitHub Actions**. The build uses
relative asset paths, so it works under any repository path.

## License

MIT — see [LICENSE](LICENSE). Third-party components: Mediabunny (MPL-2.0), OpenCV.js via
`@techstark/opencv-js` (Apache-2.0), Svelte (MIT).
