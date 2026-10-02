import { rotate, type Similarity, type Vec2 } from './affine'

export interface Correspondence {
  /** Point in the reference frame. */
  from: Vec2
  /** Where that point was observed in the current frame. */
  to: Vec2
  weight: number
}

/** Weighted mean displacement. Returns null when there are no correspondences. */
export function fitTranslation(pairs: readonly Correspondence[]): Vec2 | null {
  let sw = 0
  let x = 0
  let y = 0
  for (const p of pairs) {
    sw += p.weight
    x += p.weight * (p.to.x - p.from.x)
    y += p.weight * (p.to.y - p.from.y)
  }
  if (sw <= 0) return null
  return { x: x / sw, y: y / sw }
}

/**
 * Weighted least-squares similarity (Umeyama, no reflection) mapping `from` → `to`, expressed about
 * `pivot`. Needs at least two correspondences that are not coincident; returns null otherwise.
 */
export function fitSimilarity(pairs: readonly Correspondence[], pivot: Vec2): Similarity | null {
  if (pairs.length < 2) return null
  let sw = 0
  let fx = 0
  let fy = 0
  let tx = 0
  let ty = 0
  for (const p of pairs) {
    sw += p.weight
    fx += p.weight * p.from.x
    fy += p.weight * p.from.y
    tx += p.weight * p.to.x
    ty += p.weight * p.to.y
  }
  if (sw <= 0) return null
  fx /= sw
  fy /= sw
  tx /= sw
  ty /= sw

  let dot = 0
  let cross = 0
  let varFrom = 0
  for (const p of pairs) {
    const ax = p.from.x - fx
    const ay = p.from.y - fy
    const bx = p.to.x - tx
    const by = p.to.y - ty
    dot += p.weight * (ax * bx + ay * by)
    cross += p.weight * (ax * by - ay * bx)
    varFrom += p.weight * (ax * ax + ay * ay)
  }
  if (varFrom < 1e-9) return null

  const theta = Math.atan2(cross, dot)
  const s = Math.hypot(dot, cross) / varFrom
  // M(x) = s·R·(x − μf) + μt  ⇒  t = μt − p − s·R·(μf − p)
  const r = rotate({ x: fx - pivot.x, y: fy - pivot.y }, theta)
  return {
    s,
    theta,
    tx: tx - pivot.x - s * r.x,
    ty: ty - pivot.y - s * r.y,
  }
}
