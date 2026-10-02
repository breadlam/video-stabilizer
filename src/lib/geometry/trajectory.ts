import { invert, similarityToAffine, rotate, type Affine, type Similarity, type Vec2 } from './affine'
import { fitSimilarity, fitTranslation, type Correspondence } from './fit'
import { isUsable, Status, type Observations } from '../tracking/observations'

export type MotionModel = 'translation' | 'rotation'

export interface SolveOptions {
  model: MotionModel
  /** Pivot for the similarity parameterisation, normally the frame centre. */
  pivot: Vec2
  /** Gaussian jitter-filter sigma in frames; 0 disables it. */
  smoothing: number
  /** Only frames below this index are considered tracked (defaults to all). */
  trackedFrames?: number
}

export const FrameKind = {
  /** No usable anchor: parameters interpolated from neighbours. */
  Interpolated: 0,
  /** One usable anchor out of several: translation measured, rotation/zoom borrowed. */
  Partial: 1,
  /** Fully determined by this frame's observations. */
  Fit: 2,
} as const

export interface Trajectory {
  /** Camera motion per frame: maps reference-frame coordinates to frame coordinates. */
  sims: Similarity[]
  kinds: Uint8Array
  /** Affine form of `sims` (reference → frame). */
  toFrame: Affine[]
  /** Stabilizing warp (frame → reference). */
  toRef: Affine[]
}

/**
 * Turns per-anchor observations into one camera transform per frame.
 * See docs/DESIGN.md, "Solving the camera transform".
 */
export function solveTrajectory(obs: Observations, refPoints: readonly Vec2[], opts: SolveOptions): Trajectory {
  const n = obs.frames
  const tracked = Math.min(n, opts.trackedFrames ?? n)
  const rotation = opts.model === 'rotation'
  const singleAnchor = refPoints.length === 1
  const { pivot } = opts

  const s = new Float64Array(n).fill(1)
  const theta = new Float64Array(n)
  const tx = new Float64Array(n)
  const ty = new Float64Array(n)
  const kinds = new Uint8Array(n)
  const hasRot = new Uint8Array(n)
  const hasTrans = new Uint8Array(n)
  /** For partial frames: index of the single usable anchor. */
  const partialAnchor = new Int32Array(n).fill(-1)

  const pairs: Correspondence[] = []
  for (let f = 0; f < tracked; f++) {
    pairs.length = 0
    let lastUsable = -1
    for (let a = 0; a < refPoints.length; a++) {
      const o = obs.get(f, a)
      if (!isUsable(o.status)) continue
      lastUsable = a
      // Corrections and the reference frame are trusted fully; tracked matches by their score.
      const weight = o.status === Status.Key ? 1 : Math.max(0.05, o.score)
      pairs.push({ from: refPoints[a], to: { x: o.x, y: o.y }, weight })
    }
    if (pairs.length === 0) continue

    if (!rotation) {
      const t = fitTranslation(pairs)!
      tx[f] = t.x
      ty[f] = t.y
      kinds[f] = FrameKind.Fit
      hasRot[f] = 1
      hasTrans[f] = 1
    } else if (singleAnchor) {
      const o = obs.get(f, lastUsable)
      theta[f] = o.angle
      const t = translationFor(refPoints[lastUsable], { x: o.x, y: o.y }, 1, o.angle, pivot)
      tx[f] = t.x
      ty[f] = t.y
      kinds[f] = FrameKind.Fit
      hasRot[f] = 1
      hasTrans[f] = 1
    } else if (pairs.length >= 2) {
      const sim = fitSimilarity(pairs, pivot)
      if (!sim) continue
      s[f] = sim.s
      theta[f] = sim.theta
      tx[f] = sim.tx
      ty[f] = sim.ty
      kinds[f] = FrameKind.Fit
      hasRot[f] = 1
      hasTrans[f] = 1
    } else {
      kinds[f] = FrameKind.Partial
      partialAnchor[f] = lastUsable
    }
  }

  // Rotation and zoom for frames that could not determine them.
  const logS = s.map(Math.log)
  fillGaps(theta, hasRot)
  fillGaps(logS, hasRot)

  // Partial frames: translation that maps the one visible anchor exactly.
  for (let f = 0; f < tracked; f++) {
    const a = partialAnchor[f]
    if (a < 0) continue
    const o = obs.get(f, a)
    const t = translationFor(refPoints[a], { x: o.x, y: o.y }, Math.exp(logS[f]), theta[f], pivot)
    tx[f] = t.x
    ty[f] = t.y
    hasTrans[f] = 1
  }
  fillGaps(tx, hasTrans)
  fillGaps(ty, hasTrans)

  if (opts.smoothing > 0) {
    for (const arr of [theta, logS, tx, ty]) gaussianSmooth(arr, opts.smoothing)
  }

  const sims: Similarity[] = new Array(n)
  const toFrame: Affine[] = new Array(n)
  const toRef: Affine[] = new Array(n)
  for (let f = 0; f < n; f++) {
    const sim = { s: Math.exp(logS[f]), theta: theta[f], tx: tx[f], ty: ty[f] }
    sims[f] = sim
    toFrame[f] = similarityToAffine(sim, pivot)
    toRef[f] = invert(toFrame[f])
  }
  return { sims, kinds, toFrame, toRef }
}

/** Translation t such that s·R(θ)·(ref − p) + p + t = obs. */
function translationFor(ref: Vec2, observed: Vec2, scale: number, theta: number, pivot: Vec2): Vec2 {
  const r = rotate({ x: ref.x - pivot.x, y: ref.y - pivot.y }, theta)
  return { x: observed.x - pivot.x - scale * r.x, y: observed.y - pivot.y - scale * r.y }
}

/**
 * Linearly interpolates entries whose `known` flag is 0 from the nearest known neighbours, holding the
 * first/last known value at the ends. Leaves the array unchanged if nothing is known.
 */
export function fillGaps(values: Float64Array, known: Uint8Array): void {
  const n = values.length
  let prev = -1
  for (let i = 0; i < n; i++) {
    if (!known[i]) continue
    if (prev === -1) {
      for (let j = 0; j < i; j++) values[j] = values[i]
    } else if (i - prev > 1) {
      const a = values[prev]
      const b = values[i]
      for (let j = prev + 1; j < i; j++) values[j] = a + ((b - a) * (j - prev)) / (i - prev)
    }
    prev = i
  }
  if (prev >= 0) for (let j = prev + 1; j < n; j++) values[j] = values[prev]
}

/** In-place Gaussian filter with the kernel renormalised at the ends (no edge bias towards zero). */
export function gaussianSmooth(values: Float64Array, sigma: number): void {
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const kernel = new Float64Array(2 * radius + 1)
  for (let k = -radius; k <= radius; k++) kernel[k + radius] = Math.exp(-(k * k) / (2 * sigma * sigma))
  const src = values.slice()
  const n = values.length
  for (let i = 0; i < n; i++) {
    let sum = 0
    let wsum = 0
    for (let k = -radius; k <= radius; k++) {
      const j = i + k
      if (j < 0 || j >= n) continue
      const w = kernel[k + radius]
      sum += w * src[j]
      wsum += w
    }
    values[i] = sum / wsum
  }
}
