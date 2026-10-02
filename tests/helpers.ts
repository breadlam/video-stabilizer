import { createRequire } from 'node:module'
import { invert, similarityToAffine, type Affine, type Similarity, type Vec2 } from '../src/lib/geometry/affine'
import type { FrameAccess } from '../src/lib/tracking/anchorTracker'
import { resolveOpenCv, type CV, type Mat } from '../src/lib/tracking/cv'

let cvPromise: Promise<CV> | null = null
export function loadCv(): Promise<CV> {
  // Loaded through CommonJS: the module's export is a promise, which ESM interop would try to await.
  cvPromise ??= resolveOpenCv(createRequire(import.meta.url)('@techstark/opencv-js'))
  return cvPromise
}

/** FrameAccess over a grayscale cv.Mat (the test counterpart of the worker's canvas reader). */
export class MatFrame implements FrameAccess {
  constructor(
    private readonly cv: CV,
    readonly mat: Mat,
  ) {}

  get width(): number {
    return this.mat.cols
  }

  get height(): number {
    return this.mat.rows
  }

  readGray(x0: number, y0: number, outW: number, outH: number, scale: number): Mat {
    const { cv } = this
    if (scale === 1 && Number.isInteger(x0) && Number.isInteger(y0)) {
      const view = this.mat.roi(new cv.Rect(x0, y0, outW, outH))
      const out = view.clone()
      view.delete()
      return out
    }
    // dst pixel p ↔ continuous p + ½ ↔ frame continuous x0 + (p + ½)/s ↔ frame pixel that − ½
    const inv = 1 / scale
    const M = cv.matFromArray(2, 3, cv.CV_64F, [inv, 0, x0 + 0.5 * inv - 0.5, 0, inv, y0 + 0.5 * inv - 0.5])
    const out = new cv.Mat()
    cv.warpAffine(this.mat, out, M, new cv.Size(outW, outH), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE)
    M.delete()
    return out
  }
}

/** Deterministic PRNG so tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A natural-ish texture: blurred noise at several scales, normalised to 0..255. */
export function makeTexture(cv: CV, width: number, height: number, seed = 1): Mat {
  const rand = mulberry32(seed)
  const acc = new Float32Array(width * height)
  for (const [sigma, amp] of [
    [1.2, 0.5],
    [4, 1],
    [12, 1.5],
  ] as const) {
    const m = new cv.Mat(height, width, cv.CV_32F)
    const d = m.data32F
    for (let i = 0; i < d.length; i++) d[i] = rand()
    const k = Math.ceil(sigma * 3) * 2 + 1
    cv.GaussianBlur(m, m, new cv.Size(k, k), sigma)
    let lo = Infinity
    let hi = -Infinity
    for (const v of d) {
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
    for (let i = 0; i < d.length; i++) acc[i] += (amp * (d[i] - lo)) / (hi - lo)
    m.delete()
  }
  let lo = Infinity
  let hi = -Infinity
  for (const v of acc) {
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  const out = new cv.Mat(height, width, cv.CV_8UC1)
  for (let i = 0; i < acc.length; i++) out.data[i] = Math.round((255 * (acc[i] - lo)) / (hi - lo))
  return out
}

export interface SyntheticVideo {
  width: number
  height: number
  frames: Mat[]
  /** Camera motion per frame (reference → frame). */
  motion: Affine[]
  dispose(): void
}

/**
 * Renders frames of `texture` seen through a camera that moves by `sims[t]` (about the frame centre)
 * relative to the reference view at `offset`. Adds mild sensor noise.
 */
export function renderVideo(
  cv: CV,
  texture: Mat,
  width: number,
  height: number,
  offset: Vec2,
  sims: Similarity[],
  noise = 2,
  seed = 7,
): SyntheticVideo {
  const rand = mulberry32(seed)
  const pivot = { x: width / 2, y: height / 2 }
  const motion = sims.map((s) => similarityToAffine(s, pivot))
  const frames = motion.map((A) => {
    // frame(x) = texture(A⁻¹x + offset) in continuous coordinates; convert to pixel-centre form.
    const inv = invert(A)
    const bx = inv.a * 0.5 + inv.c * 0.5 + inv.e + offset.x - 0.5
    const by = inv.b * 0.5 + inv.d * 0.5 + inv.f + offset.y - 0.5
    const M = cv.matFromArray(2, 3, cv.CV_64F, [inv.a, inv.c, bx, inv.b, inv.d, by])
    const out = new cv.Mat()
    cv.warpAffine(texture, out, M, new cv.Size(width, height), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE)
    M.delete()
    if (noise > 0) {
      const d = out.data
      for (let i = 0; i < d.length; i++) {
        // Approximate Gaussian from the sum of uniforms.
        const n = (rand() + rand() + rand() - 1.5) * 2 * noise
        d[i] = Math.max(0, Math.min(255, Math.round(d[i] + n)))
      }
    }
    return out
  })
  return {
    width,
    height,
    frames,
    motion,
    dispose: () => frames.forEach((f) => f.delete()),
  }
}

/** A smooth handheld-style drift with optional roll. */
export function driftPath(n: number, opts: { amplitude?: number; roll?: number; zoom?: number } = {}): Similarity[] {
  const { amplitude = 25, roll = 0, zoom = 0 } = opts
  return Array.from({ length: n }, (_, t) => ({
    s: 1 + zoom * Math.sin(t / 17),
    theta: roll * Math.sin(t / 13 + 0.4),
    tx: amplitude * Math.sin(t / 11) + 0.35 * t,
    ty: 0.6 * amplitude * Math.cos(t / 9) - 0.6 * amplitude - 0.2 * t,
  }))
}
