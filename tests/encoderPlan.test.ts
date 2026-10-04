import { describe, expect, it } from 'vitest'
import { bitsOf, codecStrings, encodeOptions, planEncoder, type SourceEncoding } from '../src/lib/media/encoderPlan'

const src: SourceEncoding = { codec: 'hevc', codecString: 'hev1.2.4.L153.90', bits: 10, width: 3840, height: 2160, fps: 30, bitrate: 40e6 }

describe('codecStrings', () => {
  it('prefers the source string at the source bit depth', () => {
    expect(codecStrings('avc', 'avc3.64002a', 8)[0]).toBe('avc1.64002a')
    expect(codecStrings('hevc', 'hev1.2.4.L153.90', 10)[0]).toBe('hvc1.2.4.L153.90')
    expect(codecStrings('vp9', 'vp09.02.21.10.01.02.02.02.00', 10).slice(0, 2)).toEqual([
      'vp09.02.21.10.01.02.02.02.00',
      'vp09.02.21.10',
    ])
  })

  it('drops the source string when the bit depth changes', () => {
    expect(codecStrings('hevc', 'hev1.2.4.L153.90', 8)).toEqual(['hvc1.1.6.L156.B0'])
    expect(codecStrings('av1', 'av01.0.08M.10', 8)).toEqual(['av01.0.13M.08'])
  })

  it('reads bit depths', () => {
    expect(bitsOf('vp09.02.10.10')).toBe(10)
    expect(bitsOf('av01.0.04M.08')).toBe(8)
    expect(bitsOf('hvc1.2.4.L120.B0')).toBe(10)
    expect(bitsOf('avc1.640028')).toBe(8)
  })
})

describe('planEncoder', () => {
  it('keeps codec, string and bit depth with constant quality when supported', async () => {
    const plan = await planEncoder(src, 'lossless', ['hevc', 'avc'], async () => true)
    expect(plan).toMatchObject({ codec: 'hevc', bits: 10, quantizer: 7, notes: [] })
    expect(plan!.config).toMatchObject({ codec: 'hvc1.2.4.L153.90', bitrateMode: 'quantizer', hevc: { format: 'hevc' } })
  })

  it('falls back to 8-bit before changing codec, and explains why', async () => {
    const plan = await planEncoder(src, 'lossless', ['hevc', 'avc'], async (c) => !/^hvc1\.2/.test(c.codec))
    expect(plan).toMatchObject({ codec: 'hevc', bits: 8 })
    expect(plan!.notes).toEqual(['This browser cannot encode 10-bit video here, so the output is 8-bit.'])
  })

  it('uses a generous bitrate when constant quality is unavailable', async () => {
    const plan = await planEncoder({ ...src, bits: 8, codec: 'avc', codecString: 'avc1.640033' }, 'lossless', ['avc'], async (c) => c.bitrateMode !== 'quantizer')
    expect(plan!.quantizer).toBeNull()
    expect(plan!.config.bitrate).toBe(120e6)
    expect(encodeOptions(plan!, true)).toEqual({ keyFrame: true })
  })

  it('puts the quantizer in codec-specific encode options', async () => {
    const plan = (await planEncoder({ ...src, bits: 8, codec: 'av1', codecString: 'av01.0.08M.08' }, 'maximum', ['av1'], async () => true))!
    expect(encodeOptions(plan, false)).toEqual({ keyFrame: false, av1: { quantizer: 0 } })
  })

  it('switches codec when the source codec cannot be encoded at full quality', async () => {
    const vp9 = { ...src, codec: 'vp9' as const, codecString: 'vp09.00.31.08', bits: 8 as const }
    const plan = await planEncoder(vp9, 'lossless', ['vp9', 'avc'], async (_c, codec) => codec === 'avc')
    expect(plan).toMatchObject({ codec: 'avc', bits: 8, quantizer: 8 })
    expect(plan!.notes[0]).toMatch(/cannot encode VP9 at full quality/)
  })

  it('returns null when nothing can be encoded', async () => {
    expect(await planEncoder(src, 'lossless', ['hevc'], async () => false)).toBeNull()
  })
})
