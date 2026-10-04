/// <reference lib="webworker" />
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MATROSKA,
  MkvOutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  QTFF,
  StreamTarget,
  VideoSampleSink,
  WEBM,
  WebMOutputFormat,
  type InputAudioTrack,
  type InputVideoTrack,
  type OutputFormat,
  type VideoSample,
} from 'mediabunny'
import { invert, multiply, type Affine } from '../geometry/affine'
import { GpuWarper, type OutputSpec } from '../render/gpuWarp'
import { codecName, describePlan, encodeOptions, planEncoder, type Codec, type EncoderPlan } from './encoderPlan'
import type { ExportJob, ExportSummary, FromExporter, ToExporter } from './exportProtocol'
import {
  codedToDisplay,
  i420Format,
  isRgbFormat,
  matrixCoefficients,
  storedSize,
  yuvLayout,
  type Rotation,
} from './pixels'
import { nearestFrame } from './video'

declare const self: DedicatedWorkerGlobalScope

let cancelled = false

function post(msg: FromExporter, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer)
}

class Cancelled extends Error {}

const VIDEO_CODECS: Codec[] = ['avc', 'hevc', 'vp9', 'av1', 'vp8']

interface ContainerChoice {
  format: OutputFormat
  name: string
}

/**
 * The source's container (MP4 for other inputs) — unless it cannot hold the video codec, which only
 * happens when the codec had to change: then Matroska for WebM sources, MP4 otherwise.
 */
async function containerFor(input: Input, codec: Codec): Promise<{ choice: ContainerChoice; changed: boolean }> {
  const f = await input.getFormat()
  const same: ContainerChoice =
    f === QTFF
      ? { format: new MovOutputFormat(), name: 'MOV' }
      : f === WEBM
        ? { format: new WebMOutputFormat(), name: 'WebM' }
        : f === MATROSKA
          ? { format: new MkvOutputFormat(), name: 'Matroska' }
          : { format: new Mp4OutputFormat(), name: 'MP4' }
  if ((same.format.getSupportedCodecs() as string[]).includes(codec)) return { choice: same, changed: false }
  const fallback: ContainerChoice =
    f === WEBM ? { format: new MkvOutputFormat(), name: 'Matroska' } : { format: new Mp4OutputFormat(), name: 'MP4' }
  return { choice: fallback, changed: true }
}

/**
 * Finds a decoder setup that yields frames with directly readable YUV planes at the source's bit
 * depth (hardware first, then software). Falls back to RGB/opaque frames.
 */
async function openFrames(track: InputVideoTrack, sourceBits: number): Promise<{ sink: VideoSampleSink; yuv: boolean }> {
  const first = await track.getFirstTimestamp()
  for (const hardwareAcceleration of ['no-preference', 'prefer-software'] as const) {
    try {
      const sink = new VideoSampleSink(track, { hardwareAcceleration })
      const sample = await sink.getSample(first)
      const layout = yuvLayout(sample?.format)
      sample?.close()
      if (layout && layout.bits >= sourceBits) return { sink, yuv: true }
    } catch {
      // This decoder configuration is unavailable; try the next.
    }
  }
  return { sink: new VideoSampleSink(track), yuv: false }
}

async function sourceBits(track: InputVideoTrack): Promise<8 | 10 | 12> {
  const s = (await track.getCodecParameterString()) ?? ''
  const p = s.split('.')
  if ((p[0] === 'vp09' || p[0] === 'av01') && Number(p[3]) > 8) return Number(p[3]) === 12 ? 12 : 10
  if ((p[0] === 'hvc1' || p[0] === 'hev1') && p[1] === '2') return 10
  return 8
}

async function keyTimestamps(track: InputVideoTrack): Promise<Set<number>> {
  const keys = new Set<number>()
  for await (const p of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
    if (p.type === 'key') keys.add(Math.round(p.timestamp * 1e6))
  }
  return keys
}

async function copyAudio(track: InputAudioTrack, source: EncodedAudioPacketSource): Promise<void> {
  const decoderConfig = (await track.getDecoderConfig()) ?? undefined
  let first = true
  for await (const packet of new EncodedPacketSink(track).packets()) {
    if (cancelled) throw new Cancelled()
    await source.add(packet, first && decoderConfig ? { decoderConfig } : undefined)
    first = false
  }
  source.close()
}

async function run(job: ExportJob): Promise<void> {
  cancelled = false
  const input = new Input({ source: new BlobSource(job.file), formats: ALL_FORMATS })
  let warper: GpuWarper | null = null
  let encoder: VideoEncoder | null = null
  let output: Output | null = null
  let writable: FileSystemWritableFileStream | null = null
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('The file has no video track.')
    const audioTrack = await input.getPrimaryAudioTrack()
    const notes: string[] = []

    // Source description.
    const rotation = (await track.getRotation()) as Rotation
    const flip = await track.getFlip()
    const srcCodec = (await track.getCodec()) as Codec | null
    const bits = await sourceBits(track)
    const stats = await track.computePacketStats(300)
    const trackColor = await track.getColorSpace()
    const hdr = await track.hasHighDynamicRange()

    const { sink, yuv } = await openFrames(track, bits)
    if (!yuv) notes.push('This browser only provides RGB frames for this video, so colours pass through an 8-bit RGB conversion.')
    if (!yuv && hdr) notes.push('HDR is converted to SDR (BT.709).')

    // Output geometry: same orientation metadata as the source, stored (coded) size unrotated.
    const coded = storedSize(job.outWidth, job.outHeight, rotation)
    const toDisplayOut = codedToDisplay(coded.width, coded.height, rotation, flip)
    const fromDisplayOut = invert(toDisplayOut)

    const plan: EncoderPlan | null = await planEncoder(
      {
        codec: srcCodec,
        codecString: await track.getCodecParameterString(),
        bits: yuv ? bits : 8,
        width: coded.width,
        height: coded.height,
        fps: stats.averagePacketRate || 30,
        bitrate: stats.averageBitrate || null,
      },
      job.quality,
      VIDEO_CODECS,
    )
    if (!plan) throw new Error('This browser cannot encode video at sufficient quality.')
    notes.push(...plan.notes)
    const { choice, changed } = await containerFor(input, plan.codec)
    const { format, name: containerName } = choice
    const containerCodecs = format.getSupportedCodecs() as string[]
    if (changed) notes.push(`${codecName(plan.codec)} cannot be stored in the original container, so the file is ${containerName}.`)

    const colorSpace: VideoColorSpaceInit | undefined =
      !yuv && hdr
        ? { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
        : trackColor.primaries || trackColor.transfer || trackColor.matrix
          ? trackColor
          : undefined
    const out: OutputSpec = {
      width: coded.width,
      height: coded.height,
      bits: plan.bits,
      fullRange: colorSpace?.fullRange ?? false,
      fill: job.fill,
    }

    // Output file.
    writable = job.fileHandle ? await job.fileHandle.createWritable() : null
    const target = writable ? new StreamTarget(writable, { chunked: true }) : new BufferTarget()
    output = new Output({ format, target })
    const videoSource = new EncodedVideoPacketSource(plan.codec)
    output.addVideoTrack(videoSource, { rotation, flip })
    let audioSource: EncodedAudioPacketSource | null = null
    let audioName = 'none'
    if (audioTrack) {
      const audioCodec = await audioTrack.getCodec()
      if (audioCodec && containerCodecs.includes(audioCodec)) {
        audioSource = new EncodedAudioPacketSource(audioCodec)
        output.addAudioTrack(audioSource)
        audioName = `${audioCodec.toUpperCase()}, copied unchanged`
      } else {
        notes.push(`The audio track (${audioCodec ?? 'unknown codec'}) cannot be stored in ${containerName} and was left out.`)
      }
    }
    output.setMetadataTags(await input.getMetadataTags())
    await output.start()

    // Encoder: packets are muxed in the order the encoder produces them (decode order).
    let encoderError: unknown = null
    let muxing: Promise<void> = Promise.resolve()
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const m =
          meta?.decoderConfig && colorSpace ? { ...meta, decoderConfig: { ...meta.decoderConfig, colorSpace } } : meta
        muxing = muxing.then(() => videoSource.add(EncodedPacket.fromEncodedChunk(chunk), m))
      },
      error: (e) => (encoderError = e),
    })
    encoder.configure(plan.config)
    const keys = await keyTimestamps(track)

    warper = new GpuWarper()
    const total = job.timestamps.length
    const frameMatrix = (i: number): Affine => {
      const o = i * 6
      const m = job.matrices
      return { a: m[o], b: m[o + 1], c: m[o + 2], d: m[o + 3], e: m[o + 4], f: m[o + 5] }
    }
    /** Output stored coordinates → input coordinates of an image of size w×h (pre-rotation). */
    const inverseFor = (i: number, sample: VideoSample, w: number, h: number): Affine => {
      const toDisplayIn = codedToDisplay(w, h, rotation, flip, sample.squarePixelWidth / w, sample.squarePixelHeight / h)
      return invert(multiply(fromDisplayOut, multiply(frameMatrix(i), toDisplayIn)))
    }

    const videoDone = (async () => {
      let done = 0
      let lastPost = 0
      let buffer = new Uint8Array(0)
      for await (const sample of sink.samples()) {
        try {
          if (cancelled) throw new Cancelled()
          if (encoderError) throw encoderError
          const i = nearestFrame(job.timestamps, sample.timestamp)
          const layout = yuvLayout(sample.format)
          let data: Uint8Array
          if (layout) {
            const size = sample.allocationSize()
            if (buffer.length < size) buffer = new Uint8Array(size)
            const planes = await sample.copyTo(buffer)
            const { width, height } = sample.visibleRect
            data = warper!.warpYuv(buffer, planes, layout, width, height, inverseFor(i, sample, width, height), out)
          } else {
            const frame = sample.toVideoFrame()
            try {
              const coef = matrixCoefficients(colorSpace?.matrix)
              if (isRgbFormat(frame.format)) {
                const { width, height } = frame.visibleRect!
                const rgba = new Uint8Array(frame.allocationSize())
                await frame.copyTo(rgba)
                const swap = frame.format!.startsWith('BGR')
                data = warper!.warpRgb(rgba, width, height, swap, inverseFor(i, sample, width, height), coef, out)
              } else {
                const { displayWidth: width, displayHeight: height } = frame
                data = warper!.warpRgb(frame, width, height, false, inverseFor(i, sample, width, height), coef, out)
              }
            } finally {
              frame.close()
            }
          }
          const frame = new VideoFrame(data, {
            // TypeScript's DOM types predate the high-bit-depth formats.
            format: i420Format(out.bits) as VideoPixelFormat,
            codedWidth: out.width,
            codedHeight: out.height,
            timestamp: sample.microsecondTimestamp,
            duration: sample.microsecondDuration || undefined,
            colorSpace,
          })
          while (encoder!.encodeQueueSize > 4) {
            await new Promise((r) => encoder!.addEventListener('dequeue', r, { once: true }))
          }
          encoder!.encode(frame, encodeOptions(plan, done === 0 || keys.has(Math.round(sample.timestamp * 1e6))))
          frame.close()
          done++
          const now = performance.now()
          if (now - lastPost > 100) {
            lastPost = now
            post({ type: 'progress', progress: done / total })
          }
        } finally {
          sample.close()
        }
      }
      await encoder!.flush()
      if (encoderError) throw encoderError
      await muxing
      videoSource.close()
    })()

    await Promise.all([videoDone, audioTrack && audioSource ? copyAudio(audioTrack, audioSource) : null])
    await output.finalize()

    const summary: ExportSummary = {
      container: containerName,
      extension: format.fileExtension.replace(/^\./, ''),
      video: describePlan(plan),
      processing: yuv
        ? `${bits}-bit YUV planes resampled directly (Lanczos-3), no colour conversion`
        : 'RGB frames resampled (Lanczos-3) and converted to YUV with the source matrix',
      audio: audioName,
      notes,
    }
    const buffer = target instanceof BufferTarget ? target.buffer : null
    post({ type: 'done', buffer, mimeType: await output.getMimeType(), summary }, buffer ? [buffer] : [])
  } catch (err) {
    if (encoder && encoder.state !== 'closed') encoder.close()
    await output?.cancel().catch(() => {})
    await writable?.abort().catch(() => {})
    if (err instanceof Cancelled) {
      post({ type: 'cancelled' })
      return
    }
    throw err
  } finally {
    warper?.dispose()
    input.dispose()
  }
}

self.onmessage = (e: MessageEvent<ToExporter>) => {
  const msg = e.data
  if (msg.type === 'cancel') {
    cancelled = true
    return
  }
  run(msg.job).catch((err: unknown) => {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  })
}
