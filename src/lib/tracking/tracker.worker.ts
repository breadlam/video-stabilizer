/// <reference lib="webworker" />
import opencvUrl from '@techstark/opencv-js/dist/opencv.js?url'
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'
import { nearestFrame } from '../media/video'
import type { FrameAccess } from './anchorTracker'
import { resolveOpenCv, type CV, type Mat } from './cv'
import { Observations, Status } from './observations'
import type { FromTracker, ToTracker, TrackJob } from './protocol'
import { TrackSession } from './session'

declare const self: DedicatedWorkerGlobalScope

let cvPromise: Promise<CV> | null = null
let cancelRequested = false

function post(msg: FromTracker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer)
}

/**
 * Loads OpenCV.js (~13 MB, only in this worker). The file is a UMD bundle whose CommonJS export is a
 * promise; bundler interop mangles that promise, so the file is shipped as a plain asset and run
 * with a minimal CommonJS shim instead.
 */
function loadCv(): Promise<CV> {
  cvPromise ??= (async () => {
    const res = await fetch(opencvUrl)
    if (!res.ok) throw new Error(`Could not load OpenCV.js (HTTP ${res.status}).`)
    const code = await res.text()
    const module = { exports: {} as unknown }
    new Function('module', 'exports', code)(module, module.exports)
    return resolveOpenCv(module.exports)
  })()
  cvPromise.catch(() => (cvPromise = null))
  return cvPromise
}

/**
 * FrameAccess over a decoded frame canvas. Only the requested region is drawn into a small work
 * canvas and read back, so large frames never leave the GPU in full.
 */
class CanvasFrame implements FrameAccess {
  constructor(
    private readonly cv: CV,
    private readonly source: CanvasImageSource,
    readonly width: number,
    readonly height: number,
    private readonly ctx: OffscreenCanvasRenderingContext2D,
  ) {}

  readGray(x0: number, y0: number, outW: number, outH: number, scale: number): Mat {
    const { ctx, cv } = this
    const canvas = ctx.canvas
    if (canvas.width < outW || canvas.height < outH) {
      canvas.width = Math.max(canvas.width, outW)
      canvas.height = Math.max(canvas.height, outH)
    }
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, outW, outH)
    ctx.drawImage(this.source, x0, y0, outW / scale, outH / scale, 0, 0, outW, outH)
    const rgba = cv.matFromImageData(ctx.getImageData(0, 0, outW, outH))
    const gray = new cv.Mat()
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY)
    rgba.delete()
    return gray
  }
}

async function run(job: TrackJob): Promise<void> {
  cancelRequested = false
  const started = performance.now()
  post({ type: 'loading' })
  const cv = await loadCv()
  const input = new Input({ source: new BlobSource(job.file), formats: ALL_FORMATS })
  let session: TrackSession | null = null
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('The file has no video track.')
    const sink = new CanvasSink(track, { poolSize: 2 })
    const ctx = new OffscreenCanvas(256, 256).getContext('2d')!
    const { width, height } = job.config
    const { timestamps } = job
    const frameAt = (canvas: CanvasImageSource) => new CanvasFrame(cv, canvas, width, height, ctx)

    session = new TrackSession(cv, job.config, job.resume)
    for (const index of session.templateFrames()) {
      const wrapped = await sink.getCanvas(timestamps[index])
      if (!wrapped) throw new Error(`Could not decode frame ${index}.`)
      session.loadTemplates(index, frameAt(wrapped.canvas))
    }

    const start = job.resume?.startIndex ?? 0
    post({ type: 'started', startIndex: start })
    const n = timestamps.length
    const anchors = job.config.anchors.length
    const obs = new Observations(n, anchors)
    let next = start
    let flushed = start
    let lastFlush = performance.now()
    const flush = () => {
      if (next > flushed) post({ type: 'batch', batch: obs.toBatch(flushed, next - flushed) })
      flushed = next
      lastFlush = performance.now()
    }
    const markLost = (from: number, to: number) => {
      for (let f = from; f < to; f++) {
        for (let a = 0; a < anchors; a++) obs.set(f, a, { x: 0, y: 0, angle: 0, score: 0, status: Status.Lost })
      }
    }

    for await (const wrapped of sink.canvases(timestamps[start])) {
      if (cancelRequested) break
      const index = nearestFrame(timestamps, wrapped.timestamp)
      if (index < next) continue
      markLost(next, index) // frames the decoder did not produce
      session.process(index, frameAt(wrapped.canvas)).forEach((o, a) => obs.set(index, a, o))
      next = index + 1
      if (performance.now() - lastFlush > 120) {
        flush()
        // Let the cancel message through.
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    if (!cancelRequested) {
      markLost(next, n)
      next = n
    }
    flush()
    post({
      type: 'done',
      cancelled: cancelRequested,
      processed: next - start,
      seconds: (performance.now() - started) / 1000,
    })
  } finally {
    session?.dispose()
    input.dispose()
  }
}

self.onmessage = (e: MessageEvent<ToTracker>) => {
  const msg = e.data
  if (msg.type === 'cancel') {
    cancelRequested = true
    return
  }
  run(msg.job).catch((err: unknown) => {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  })
}
