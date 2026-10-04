/**
 * Chooses a WebCodecs encoder configuration that reproduces the source encoding as closely as the
 * browser allows: same codec (and profile/level string where accepted), same bit depth, and a
 * constant-quality (quantizer) mode at a quality that makes re-encoding effectively lossless.
 * Falls back step by step, recording why.
 */

export type Codec = 'avc' | 'hevc' | 'vp9' | 'av1' | 'vp8'
export type QualityPreset = 'lossless' | 'maximum' | 'compact'

/**
 * Constant quantizer per codec and preset (AVC/HEVC: 0–51, VP9/AV1: 0–63; lower is better).
 * Calibrated in Chrome by re-encoding a high-detail test video and measuring luma PSNR against the
 * decoded source: 'lossless' ≈ 51–52 dB (well under one code value RMS), 'maximum' ≥ 54 dB (VP9 at
 * 0 is mathematically lossless), 'compact' ≈ 48–49 dB.
 */
export const QUANTIZERS: Record<Exclude<Codec, 'vp8'>, Record<QualityPreset, number>> = {
  avc: { maximum: 2, lossless: 8, compact: 14 },
  hevc: { maximum: 3, lossless: 7, compact: 12 },
  vp9: { maximum: 0, lossless: 1, compact: 4 },
  av1: { maximum: 0, lossless: 2, compact: 5 },
}

/** Bitrate relative to the source when constant quality is unavailable. */
const BITRATE_FACTOR: Record<QualityPreset, number> = { maximum: 6, lossless: 3, compact: 1.5 }
/** Minimum bits per pixel per frame for bitrate-based fallbacks. */
const MIN_BPP: Record<QualityPreset, number> = { maximum: 0.6, lossless: 0.3, compact: 0.12 }

export interface SourceEncoding {
  codec: Codec | null
  /** Full codec parameter string of the source track, e.g. avc1.64002a. */
  codecString: string | null
  bits: 8 | 10 | 12
  width: number
  height: number
  fps: number
  /** Average video bitrate in bits/s, if known. */
  bitrate: number | null
}

export interface EncoderPlan {
  codec: Codec
  config: VideoEncoderConfig
  /** Per-frame quantizer (constant-quality mode), or null for bitrate mode. */
  quantizer: number | null
  bits: 8 | 10 | 12
  /** Human-readable deviations from the source encoding. */
  notes: string[]
}

const CODEC_NAMES: Record<Codec, string> = { avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8' }
export function codecName(c: Codec | null): string {
  return c ? CODEC_NAMES[c] : 'unknown'
}

/** Codec strings to try for a codec and bit depth, most faithful first. */
export function codecStrings(codec: Codec, source: string | null, bits: number): string[] {
  const out: string[] = []
  // The source's own string only applies at the source's bit depth.
  const src = source && sameCodec(codec, source) && (bitsOf(source) ?? 8) === bits ? source : null
  switch (codec) {
    case 'avc':
      if (src) out.push(src.replace(/^avc3/, 'avc1'))
      if (bits === 8) out.push('avc1.640034', 'avc1.4d0034', 'avc1.420034')
      break
    case 'hevc':
      if (src) out.push(src.replace(/^hev1/, 'hvc1'))
      out.push(bits > 8 ? 'hvc1.2.4.L156.B0' : 'hvc1.1.6.L156.B0')
      break
    case 'vp9':
      if (src) out.push(src, src.split('.').slice(0, 4).join('.'))
      out.push(bits > 8 ? `vp09.02.51.${pad(bits)}` : 'vp09.00.51.08')
      break
    case 'av1':
      if (src) out.push(src, src.split('.').slice(0, 4).join('.'))
      out.push(`av01.0.13M.${pad(bits)}`)
      break
    case 'vp8':
      if (bits === 8) out.push('vp8')
      break
  }
  return [...new Set(out)]
}

function pad(bits: number): string {
  return String(bits).padStart(2, '0')
}

function sameCodec(codec: Codec, s: string): boolean {
  const prefix = s.split('.')[0]
  return (
    (codec === 'avc' && (prefix === 'avc1' || prefix === 'avc3')) ||
    (codec === 'hevc' && (prefix === 'hvc1' || prefix === 'hev1')) ||
    (codec === 'vp9' && prefix === 'vp09') ||
    (codec === 'av1' && prefix === 'av01') ||
    (codec === 'vp8' && prefix === 'vp8')
  )
}

/** Bit depth encoded in a codec string, when it says. */
export function bitsOf(s: string): number | null {
  const parts = s.split('.')
  if (parts[0] === 'vp09' && parts[3]) return Number(parts[3])
  if (parts[0] === 'av01' && parts[3]) return Number(parts[3])
  if (parts[0] === 'hvc1' || parts[0] === 'hev1') return parts[1] === '2' ? 10 : 8
  if ((parts[0] === 'avc1' || parts[0] === 'avc3') && parts[1]) return parts[1].slice(0, 2).toLowerCase() === '6e' ? 10 : 8
  return null
}

/** Whether a configuration can be used: supported, and its quality setting actually takes effect. */
export type ConfigCheck = (config: VideoEncoderConfig, codec: Codec) => Promise<boolean>

export const browserCheck: ConfigCheck = async (config, codec) => {
  try {
    if (!(await VideoEncoder.isConfigSupported(config)).supported) return false
    return await rateControlTakesEffect(config, codec)
  } catch {
    return false
  }
}

/**
 * Some encoders accept a rate-control mode but ignore it (e.g. Firefox ignores quantizers, and
 * bitrates for VP9/AV1). Encode one frame of structured content at a high and a low setting: if the
 * outputs are about the same size, the setting has no effect. (Pure noise is a poor probe: it barely
 * compresses at any setting, and some hardware encoders reject it at very low quantizers.)
 */
async function rateControlTakesEffect(config: VideoEncoderConfig, codec: Codec): Promise<boolean> {
  const size = 256
  const frameData = new Uint8Array(size * size * 1.5).fill(128)
  let seed = 12345
  for (let i = 0; i < size * size; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    const x = i % size
    const y = (i / size) | 0
    const v = 128 + 60 * Math.sin(x / 7) * Math.cos(y / 5) + 30 * Math.sin((x + 2 * y) / 3) + ((seed >>> 24) - 128) / 16
    frameData[i] = Math.max(0, Math.min(255, Math.round(v)))
  }
  const [fine, coarse] = codec === 'avc' || codec === 'hevc' ? [8, 40] : [4, 56]
  const bytes = async (high: boolean): Promise<number> => {
    let total = 0
    const encoder = new VideoEncoder({ output: (chunk) => (total += chunk.byteLength), error: () => {} })
    try {
      const quantizer = config.bitrateMode === 'quantizer'
      encoder.configure({ ...config, width: size, height: size, ...(quantizer ? {} : { bitrate: high ? 20e6 : 2e5 }) })
      const frame = new VideoFrame(frameData, { format: 'I420', codedWidth: size, codedHeight: size, timestamp: 0 })
      const options = quantizer
        ? ({ keyFrame: true, [codec]: { quantizer: high ? fine : coarse } } as VideoEncoderEncodeOptions)
        : { keyFrame: true }
      encoder.encode(frame, options)
      frame.close()
      await encoder.flush()
      return total
    } finally {
      if (encoder.state !== 'closed') encoder.close()
    }
  }
  const high = await bytes(true)
  const low = await bytes(false)
  return high > 1.5 * low
}

/**
 * Picks the most faithful configuration whose quality setting works: the source codec at its bit
 * depth, then at 8 bits, then other codecs in the order given. Quality wins over sameness: a codec
 * that cannot be encoded at full quality is skipped.
 */
export async function planEncoder(
  src: SourceEncoding,
  preset: QualityPreset,
  codecs: Codec[],
  check: ConfigCheck = browserCheck,
): Promise<EncoderPlan | null> {
  const same = src.codec && codecs.includes(src.codec) ? src.codec : null
  const depths = [...new Set([src.bits, 8 as const])]
  const attempts: [Codec, 8 | 10 | 12][] = [
    ...(same ? depths.map((b) => [same, b] as [Codec, 8 | 10 | 12]) : []),
    ...depths.flatMap((b) => codecs.filter((c) => c !== same).map((c) => [c, b] as [Codec, 8 | 10 | 12])),
  ]
  for (const [codec, bits] of attempts) {
    for (const mode of ['quantizer', 'variable'] as const) {
      if (mode === 'quantizer' && codec === 'vp8') continue
      for (const codecString of codecStrings(codec, src.codecString, bits)) {
        for (const hardwareAcceleration of ['no-preference', 'prefer-software'] as const) {
          const config = buildConfig(codec, codecString, src, mode, preset, hardwareAcceleration)
          if (!(await check(config, codec))) continue
          const notes: string[] = []
          if (codec !== src.codec) {
            notes.push(`This browser cannot encode ${codecName(src.codec)} at full quality, so ${codecName(codec)} is used instead.`)
          }
          if (bits < src.bits) notes.push(`This browser cannot encode ${src.bits}-bit video here, so the output is 8-bit.`)
          if (mode === 'variable') {
            notes.push(`Constant-quality encoding has no effect in this browser; a high bitrate (${(config.bitrate! / 1e6).toFixed(0)} Mbit/s) is used instead.`)
          }
          return {
            codec,
            config,
            quantizer: mode === 'quantizer' ? QUANTIZERS[codec as Exclude<Codec, 'vp8'>][preset] : null,
            bits,
            notes,
          }
        }
      }
    }
  }
  return null
}

function buildConfig(
  codec: Codec,
  codecString: string,
  src: SourceEncoding,
  mode: 'quantizer' | 'variable',
  preset: QualityPreset,
  hardwareAcceleration: HardwareAcceleration,
): VideoEncoderConfig {
  const config: VideoEncoderConfig & { hevc?: { format: string } } = {
    codec: codecString,
    width: src.width,
    height: src.height,
    framerate: src.fps,
    bitrateMode: mode,
    latencyMode: 'quality',
    hardwareAcceleration,
  }
  if (mode === 'variable') {
    const floor = MIN_BPP[preset] * src.width * src.height * src.fps
    config.bitrate = Math.round(Math.max(floor, (src.bitrate ?? 0) * BITRATE_FACTOR[preset]))
  }
  if (codec === 'avc') config.avc = { format: 'avc' }
  if (codec === 'hevc') config.hevc = { format: 'hevc' }
  return config
}

/** Per-frame encode options carrying the quantizer. */
export function encodeOptions(plan: EncoderPlan, keyFrame: boolean): VideoEncoderEncodeOptions {
  if (plan.quantizer === null) return { keyFrame }
  return { keyFrame, [plan.codec]: { quantizer: plan.quantizer } } as VideoEncoderEncodeOptions
}

/** Short description of a plan, for the UI. */
export function describePlan(plan: EncoderPlan): string {
  const quality = plan.quantizer !== null ? `constant quality (quantizer ${plan.quantizer})` : `${((plan.config.bitrate ?? 0) / 1e6).toFixed(0)} Mbit/s`
  return `${codecName(plan.codec)} ${plan.config.codec}, ${plan.bits}-bit 4:2:0, ${quality}`
}
