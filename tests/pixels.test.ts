import { describe, expect, it } from 'vitest'
import { apply, invert, multiply, translation } from '../src/lib/geometry/affine'
import { codedToDisplay, planeSamplingMatrix, storedSize, yuvLayout } from '../src/lib/media/pixels'

describe('yuvLayout', () => {
  it('recognises planar and semi-planar formats', () => {
    expect(yuvLayout('I420')).toEqual({ bits: 8, subX: 2, subY: 2, interleaved: false })
    expect(yuvLayout('I420P10')).toEqual({ bits: 10, subX: 2, subY: 2, interleaved: false })
    expect(yuvLayout('I422P12')).toEqual({ bits: 12, subX: 2, subY: 1, interleaved: false })
    expect(yuvLayout('I444')).toEqual({ bits: 8, subX: 1, subY: 1, interleaved: false })
    expect(yuvLayout('I420A')).toEqual({ bits: 8, subX: 2, subY: 2, interleaved: false })
    expect(yuvLayout('NV12')).toEqual({ bits: 8, subX: 2, subY: 2, interleaved: true })
    expect(yuvLayout('BGRX')).toBeNull()
    expect(yuvLayout(null)).toBeNull()
  })
})

describe('codedToDisplay', () => {
  const W = 1920
  const H = 1080
  const corners = (r: 0 | 90 | 180 | 270, flip = false) =>
    [
      [0, 0],
      [W, 0],
      [W, H],
    ].map(([x, y]) => apply(codedToDisplay(W, H, r, flip), { x, y }))

  it('rotates clockwise', () => {
    // 90° clockwise: the top-left corner ends up top-right in a 1080×1920 display.
    expect(corners(90)).toEqual([
      { x: 1080, y: 0 },
      { x: 1080, y: 1920 },
      { x: 0, y: 1920 },
    ])
    expect(corners(180)[0]).toEqual({ x: W, y: H })
    expect(corners(270)[0]).toEqual({ x: 0, y: W })
  })

  it('flips after rotating and applies pixel aspect first', () => {
    expect(corners(0, true)[0]).toEqual({ x: W, y: 0 })
    const anamorphic = codedToDisplay(1440, 1080, 0, false, 4 / 3)
    expect(apply(anamorphic, { x: 1440, y: 1080 })).toEqual({ x: 1920, y: 1080 })
  })

  it('reports stored sizes', () => {
    expect(storedSize(1080, 1920, 90)).toEqual({ width: 1920, height: 1080 })
    expect(storedSize(1920, 1080, 180)).toEqual({ width: 1920, height: 1080 })
  })
})

describe('planeSamplingMatrix', () => {
  it('is the identity for an identity warp, in every plane', () => {
    const m = planeSamplingMatrix(translation(0, 0), [2, 2], [2, 2])
    for (const p of [
      { x: 0.5, y: 0.5 },
      { x: 13.5, y: 7.5 },
    ]) {
      const q = apply(m, p)
      expect(q.x).toBeCloseTo(p.x, 12)
      expect(q.y).toBeCloseTo(p.y, 12)
    }
  })

  it('halves translations for subsampled chroma', () => {
    const m = planeSamplingMatrix(translation(3, -5), [2, 2], [2, 2])
    const q = apply(m, { x: 10.5, y: 10.5 })
    expect(q.x).toBeCloseTo(12, 12)
    expect(q.y).toBeCloseTo(8, 12)
  })

  it('composes with display transforms consistently', () => {
    // A display-space shift of the output must appear as the matching coded-space shift.
    const D = codedToDisplay(640, 360, 90, false)
    const shiftDisplay = translation(4, 0)
    const coded = multiply(invert(D), multiply(shiftDisplay, D))
    const p = apply(coded, { x: 100, y: 100 })
    // Display +x is coded −y for a 90° clockwise rotation.
    expect(p.x).toBeCloseTo(100, 12)
    expect(p.y).toBeCloseTo(96, 12)
  })
})
