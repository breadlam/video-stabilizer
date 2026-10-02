/// <reference lib="webworker" />
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  ConversionCanceledError,
  getFirstEncodableVideoCodec,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  StreamTarget,
  type VideoSample,
} from 'mediabunny'
import type { ExportJob, FromExporter, ToExporter } from './exportProtocol'
import { nearestFrame } from './video'

declare const self: DedicatedWorkerGlobalScope

let current: Conversion | null = null

function post(msg: FromExporter, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer)
}

const QUALITIES = { medium: QUALITY_MEDIUM, high: QUALITY_HIGH, 'very-high': QUALITY_VERY_HIGH }

async function run(job: ExportJob): Promise<void> {
  const { outWidth: W, outHeight: H, timestamps, matrices } = job
  const quality = QUALITIES[job.quality]
  const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: W, height: H, quality })
  if (!codec) throw new Error(`This browser cannot encode ${W}×${H} video.`)

  const writable = job.fileHandle ? await job.fileHandle.createWritable() : null
  const target = writable ? new StreamTarget(writable, { chunked: true }) : new BufferTarget()
  const input = new Input({ source: new BlobSource(job.file), formats: ALL_FORMATS })
  const output = new Output({ format: new Mp4OutputFormat(), target })

  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d', { alpha: false })!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // The conversion shifts timestamps so the output starts at `start`; undo that to find the frame.
  const start = Math.max(0, timestamps[0])
  const draw = (sample: VideoSample) => {
    const i = nearestFrame(timestamps, sample.timestamp + start) * 6
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (job.fill === 'black') {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, W, H)
    }
    ctx.setTransform(matrices[i], matrices[i + 1], matrices[i + 2], matrices[i + 3], matrices[i + 4], matrices[i + 5])
    sample.draw(ctx, 0, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    return canvas
  }

  try {
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      trim: { start },
      showWarnings: false,
      video: {
        codec,
        quality,
        forceTranscode: true,
        process: draw,
        processedWidth: W,
        processedHeight: H,
      },
    })
    const warnings = conversion.discardedTracks.map((d) => `Dropped ${d.track.type} track (${d.reason}).`)
    if (!conversion.isValid || !conversion.utilizedTracks.some((t) => t.type === 'video')) {
      throw new Error(`Cannot export this video. ${warnings.join(' ')}`)
    }
    current = conversion
    let lastPost = 0
    conversion.onProgress = (p) => {
      const now = performance.now()
      if (now - lastPost > 100 || p === 1) {
        lastPost = now
        post({ type: 'progress', progress: p })
      }
    }
    await conversion.execute()
    const buffer = target instanceof BufferTarget ? target.buffer : null
    post(
      { type: 'done', buffer, mimeType: await output.getMimeType(), codec, warnings },
      buffer ? [buffer] : [],
    )
  } catch (err) {
    if (err instanceof ConversionCanceledError) {
      await writable?.abort().catch(() => {})
      post({ type: 'cancelled' })
      return
    }
    await writable?.abort().catch(() => {})
    throw err
  } finally {
    current = null
    input.dispose()
  }
}

self.onmessage = (e: MessageEvent<ToExporter>) => {
  const msg = e.data
  if (msg.type === 'cancel') {
    void current?.cancel()
    return
  }
  run(msg.job).catch((err: unknown) => {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  })
}
