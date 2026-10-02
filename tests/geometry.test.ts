import { describe, expect, it } from 'vitest'
import {
  apply,
  invert,
  multiply,
  similarityToAffine,
  translation,
  type Similarity,
  type Vec2,
} from '../src/lib/geometry/affine'
import { autoCrop, cropForZoom } from '../src/lib/geometry/crop'
import { fitSimilarity, fitTranslation } from '../src/lib/geometry/fit'
import { FrameKind, fillGaps, gaussianSmooth, solveTrajectory } from '../src/lib/geometry/trajectory'
import { Observations, Status } from '../src/lib/tracking/observations'

const pivot = { x: 320, y: 240 }

function close(a: Vec2, b: Vec2, eps = 1e-9) {
  expect(Math.abs(a.x - b.x)).toBeLessThan(eps)
  expect(Math.abs(a.y - b.y)).toBeLessThan(eps)
}

describe('affine', () => {
  it('inverts and composes', () => {
    const m = similarityToAffine({ s: 1.2, theta: 0.3, tx: 5, ty: -7 }, pivot)
    const p = { x: 12, y: 34 }
    close(apply(invert(m), apply(m, p)), p)
    close(apply(multiply(m, translation(3, 4)), p), apply(m, { x: 15, y: 38 }))
  })

  it('keeps the pivot fixed apart from translation', () => {
    const m = similarityToAffine({ s: 0.9, theta: -0.5, tx: 2, ty: 3 }, pivot)
    close(apply(m, pivot), { x: pivot.x + 2, y: pivot.y + 3 })
  })
})

describe('fit', () => {
  const truth: Similarity = { s: 1.03, theta: 0.04, tx: 12, ty: -5 }
  const M = similarityToAffine(truth, pivot)
  const refs = [
    { x: 100, y: 80 },
    { x: 500, y: 120 },
    { x: 300, y: 400 },
  ]

  it('recovers an exact similarity', () => {
    const sim = fitSimilarity(
      refs.map((r) => ({ from: r, to: apply(M, r), weight: 1 })),
      pivot,
    )!
    expect(sim.s).toBeCloseTo(truth.s, 9)
    expect(sim.theta).toBeCloseTo(truth.theta, 9)
    expect(sim.tx).toBeCloseTo(truth.tx, 7)
    expect(sim.ty).toBeCloseTo(truth.ty, 7)
  })

  it('needs two distinct points', () => {
    expect(fitSimilarity([{ from: refs[0], to: refs[1], weight: 1 }], pivot)).toBeNull()
    expect(fitSimilarity([0, 1].map(() => ({ from: refs[0], to: refs[1], weight: 1 })), pivot)).toBeNull()
  })

  it('weights translations', () => {
    const t = fitTranslation([
      { from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, weight: 3 },
      { from: { x: 0, y: 0 }, to: { x: 0, y: 10 }, weight: 1 },
    ])!
    close(t, { x: 7.5, y: 2.5 })
  })
})

describe('gap filling and smoothing', () => {
  it('interpolates interior gaps and holds the ends', () => {
    const v = new Float64Array([0, 0, 2, 0, 0, 8, 0])
    fillGaps(v, new Uint8Array([0, 0, 1, 0, 0, 1, 0]))
    expect(Array.from(v)).toEqual([2, 2, 2, 4, 6, 8, 8])
  })

  it('leaves linear trends untouched in the interior and constants everywhere', () => {
    const c = new Float64Array(50).fill(3)
    gaussianSmooth(c, 4)
    for (const v of c) expect(v).toBeCloseTo(3, 12)
    const lin = Float64Array.from({ length: 50 }, (_, i) => i)
    gaussianSmooth(lin, 2)
    expect(lin[25]).toBeCloseTo(25, 9)
  })
})

function obsFrom(frames: Vec2[][], status: (f: number, a: number) => number = () => Status.Ok): Observations {
  const o = new Observations(frames.length, frames[0].length)
  frames.forEach((anchors, f) =>
    anchors.forEach((p, a) => o.set(f, a, { x: p.x, y: p.y, angle: 0, score: 0.95, status: status(f, a) as Status })),
  )
  return o
}

describe('solveTrajectory', () => {
  const refs = [
    { x: 100, y: 100 },
    { x: 500, y: 380 },
  ]
  const sims: Similarity[] = Array.from({ length: 20 }, (_, t) => ({
    s: 1 + 0.002 * t,
    theta: 0.003 * t,
    tx: t * 1.5,
    ty: -t,
  }))
  const truthAffines = sims.map((s) => similarityToAffine(s, pivot))
  const frames = truthAffines.map((M) => refs.map((r) => apply(M, r)))

  it('recovers translation with one anchor', () => {
    const obs = obsFrom(frames.map((f) => [f[0]]))
    const tr = solveTrajectory(obs, [refs[0]], { model: 'translation', pivot, smoothing: 0 })
    tr.toFrame.forEach((M, t) => close(apply(M, refs[0]), frames[t][0], 1e-6))
  })

  it('recovers a similarity with two anchors', () => {
    const tr = solveTrajectory(obsFrom(frames), refs, { model: 'rotation', pivot, smoothing: 0 })
    tr.sims.forEach((s, t) => {
      expect(s.theta).toBeCloseTo(sims[t].theta, 9)
      expect(s.s).toBeCloseTo(sims[t].s, 9)
    })
    expect(Array.from(tr.kinds).every((k) => k === FrameKind.Fit)).toBe(true)
  })

  it('borrows rotation for frames with one visible anchor and pins that anchor', () => {
    const obs = obsFrom(frames, (f, a) => (f === 7 && a === 1 ? Status.Lost : Status.Ok))
    const tr = solveTrajectory(obs, refs, { model: 'rotation', pivot, smoothing: 0 })
    expect(tr.kinds[7]).toBe(FrameKind.Partial)
    expect(tr.sims[7].theta).toBeCloseTo((sims[6].theta + sims[8].theta) / 2, 9)
    close(apply(tr.toFrame[7], refs[0]), frames[7][0], 1e-6)
  })

  it('interpolates frames without usable anchors', () => {
    const obs = obsFrom(frames, (f) => (f >= 5 && f <= 9 ? Status.Low : Status.Ok))
    const tr = solveTrajectory(obs, refs, { model: 'rotation', pivot, smoothing: 0 })
    expect(tr.kinds[7]).toBe(FrameKind.Interpolated)
    // Linear motion ⇒ linear interpolation is exact for the translation.
    expect(tr.sims[7].tx).toBeCloseTo(sims[7].tx, 6)
  })

  it('stabilizing warp maps observed anchors back to their reference positions', () => {
    const tr = solveTrajectory(obsFrom(frames), refs, { model: 'rotation', pivot, smoothing: 0 })
    frames.forEach((f, t) => refs.forEach((r, a) => close(apply(tr.toRef[t], f[a]), r, 1e-6)))
  })
})

describe('autoCrop', () => {
  const W = 640
  const H = 480

  it('handles pure translation drift', () => {
    const shifts = [
      [-10, 4],
      [20, -6],
      [0, 0],
    ]
    const toRef = shifts.map(([x, y]) => translation(-x, -y))
    const { rect, zoom } = autoCrop(toRef, W, H)
    // Common area is x ∈ [10, 620], y ∈ [6, 476]: width 610 → k = 610/640 limits (height needs 457.5 ≤ 470).
    expect(rect.w).toBeCloseTo(610, 3)
    expect(rect.h).toBeCloseTo((610 * H) / W, 3)
    expect(rect.x).toBeCloseTo(10, 3)
    expect(zoom).toBeCloseTo(640 / 610, 4)
  })

  it('keeps the crop inside every rotated frame', () => {
    const toRef = [0, 0.03, -0.05, 0.02].map((theta, i) =>
      invert(similarityToAffine({ s: 1, theta, tx: i * 5, ty: -i * 3 }, { x: W / 2, y: H / 2 })),
    )
    const { rect } = autoCrop(toRef, W, H)
    const corners = [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.w, y: rect.y },
      { x: rect.x + rect.w, y: rect.y + rect.h },
      { x: rect.x, y: rect.y + rect.h },
    ]
    for (const m of toRef) {
      const back = invert(m)
      for (const c of corners) {
        const p = apply(back, c)
        expect(p.x).toBeGreaterThanOrEqual(-1e-6)
        expect(p.y).toBeGreaterThanOrEqual(-1e-6)
        expect(p.x).toBeLessThanOrEqual(W + 1e-6)
        expect(p.y).toBeLessThanOrEqual(H + 1e-6)
      }
    }
    expect(rect.w / W).toBeGreaterThan(0.8)
  })

  it('returns the full frame without motion and clamps manual zoom into the frame', () => {
    const auto = autoCrop([translation(0, 0)], W, H)
    expect(auto.zoom).toBeCloseTo(1, 6)
    const shifted = autoCrop([translation(-40, 0), translation(0, 0)], W, H)
    const z = cropForZoom(shifted, 1, W, H)
    expect(z.rect).toEqual({ x: 0, y: 0, w: W, h: H })
  })
})
