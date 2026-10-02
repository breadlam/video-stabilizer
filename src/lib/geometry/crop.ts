import { apply, type Affine, type Vec2 } from './affine'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface CropResult {
  /** Crop rectangle in reference-frame coordinates (same aspect ratio as the frame). */
  rect: Rect
  /** Magnification needed to fill the output with the crop: width / rect.w. */
  zoom: number
}

/** Inward half-planes "n·x ≥ d" of a convex polygon. */
function halfPlanes(poly: readonly Vec2[]): { nx: number; ny: number; d: number }[] {
  let cx = 0
  let cy = 0
  for (const p of poly) {
    cx += p.x / poly.length
    cy += p.y / poly.length
  }
  const out = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    let nx = -(b.y - a.y)
    let ny = b.x - a.x
    const len = Math.hypot(nx, ny)
    if (len < 1e-9) continue
    nx /= len
    ny /= len
    let d = nx * a.x + ny * a.y
    if (nx * cx + ny * cy < d) {
      nx = -nx
      ny = -ny
      d = -d
    }
    out.push({ nx, ny, d })
  }
  return out
}

/** Sutherland–Hodgman clip of a convex polygon against the half-plane n·x ≥ d. */
function clip(poly: Vec2[], nx: number, ny: number, d: number): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const da = nx * a.x + ny * a.y - d
    const db = nx * b.x + ny * b.y - d
    if (da >= 0) out.push(a)
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db)
      out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) })
    }
  }
  return out
}

/**
 * The region covered by every stabilized frame (and by the reference frame), as half-plane
 * constraints packed as [nx, ny, d, q] where q = |nx|·W/2 + |ny|·H/2 is the support of a unit-scale
 * crop rectangle. Returns null when the frames have no common area.
 */
function buildConstraints(toRef: readonly Affine[], width: number, height: number): Float64Array | null {
  const corners: Vec2[] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]
  let poly = corners
  for (const m of toRef) {
    for (const h of halfPlanes(corners.map((c) => apply(m, c)))) {
      poly = clip(poly, h.nx, h.ny, h.d)
      if (poly.length < 3) return null
    }
  }
  const planes = halfPlanes(poly)
  const out = new Float64Array(planes.length * 4)
  planes.forEach((h, i) => {
    out.set([h.nx, h.ny, h.d, (Math.abs(h.nx) * width) / 2 + (Math.abs(h.ny) * height) / 2], i * 4)
  })
  return out
}

/** Largest relative crop size k (crop = k·W × k·H) centred at c that satisfies every constraint. */
function maxScaleAt(cons: Float64Array, cx: number, cy: number): number {
  let k = Infinity
  for (let i = 0; i < cons.length; i += 4) {
    const v = (cons[i] * cx + cons[i + 1] * cy - cons[i + 2]) / cons[i + 3]
    if (v < k) k = v
  }
  return k
}

function ternaryMax(lo: number, hi: number, f: (x: number) => number, iterations: number): number {
  for (let i = 0; i < iterations; i++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    if (f(m1) < f(m2)) lo = m1
    else hi = m2
  }
  return (lo + hi) / 2
}

/**
 * Finds the largest rectangle with the frame's aspect ratio that lies inside every stabilized
 * frame. The feasible scale is a concave function of the centre (a minimum of affine functions),
 * so a nested ternary search over the centre finds the optimum.
 */
export function autoCrop(toRef: readonly Affine[], width: number, height: number): CropResult {
  if (toRef.length === 0) return { rect: { x: 0, y: 0, w: width, h: height }, zoom: 1 }
  const cons = buildConstraints(toRef, width, height)
  if (!cons) {
    const k = 0.05
    return { rect: centredRect(width / 2, height / 2, k, width, height), zoom: 1 / k }
  }
  const iterations = 48
  const bestY = (cx: number) => ternaryMax(0, height, (cy) => maxScaleAt(cons, cx, cy), iterations)
  const cx = ternaryMax(0, width, (x) => maxScaleAt(cons, x, bestY(x)), iterations)
  const cy = bestY(cx)
  // Never larger than the frame itself, never degenerate.
  const k = Math.min(1, Math.max(0.05, maxScaleAt(cons, cx, cy)))
  return { rect: centredRect(cx, cy, k, width, height), zoom: 1 / k }
}

/**
 * A crop for an explicit zoom between 1 (whole frame) and the auto zoom: same centre as the auto crop
 * where possible, shifted so it stays within the reference frame.
 */
export function cropForZoom(auto: CropResult, zoom: number, width: number, height: number): CropResult {
  const z = Math.max(1, zoom)
  const k = 1 / z
  const cx = auto.rect.x + auto.rect.w / 2
  const cy = auto.rect.y + auto.rect.h / 2
  const hw = (k * width) / 2
  const hh = (k * height) / 2
  const x = Math.min(Math.max(cx, hw), width - hw)
  const y = Math.min(Math.max(cy, hh), height - hh)
  return { rect: centredRect(x, y, k, width, height), zoom: z }
}

function centredRect(cx: number, cy: number, k: number, width: number, height: number): Rect {
  const w = k * width
  const h = k * height
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}
