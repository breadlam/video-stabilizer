/** A 2D point / vector. */
export interface Vec2 {
  x: number
  y: number
}

/**
 * 2D affine transform in canvas `setTransform` order:
 *   x' = a·x + c·y + e
 *   y' = b·x + d·y + f
 */
export interface Affine {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

/**
 * Similarity transform about a pivot point p:
 *   M(x) = s·R(θ)·(x − p) + p + (tx, ty)
 * θ is in radians, measured in image coordinates (x right, y down), so a positive θ appears clockwise
 * on screen. Parameterising around a pivot (the frame centre) keeps the translation meaningful when
 * interpolating or smoothing.
 */
export interface Similarity {
  s: number
  theta: number
  tx: number
  ty: number
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
export const IDENTITY_SIM: Similarity = { s: 1, theta: 0, tx: 0, ty: 0 }

export function apply(m: Affine, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
}

/** Returns m ∘ n, i.e. the transform that applies n first, then m. */
export function multiply(m: Affine, n: Affine): Affine {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  }
}

export function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c
  if (Math.abs(det) < 1e-12) throw new Error('Affine transform is not invertible')
  const a = m.d / det
  const b = -m.b / det
  const c = -m.c / det
  const d = m.a / det
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) }
}

export function translation(tx: number, ty: number): Affine {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty }
}

export function scaling(sx: number, sy: number = sx): Affine {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }
}

export function similarityToAffine(sim: Similarity, pivot: Vec2): Affine {
  const cos = sim.s * Math.cos(sim.theta)
  const sin = sim.s * Math.sin(sim.theta)
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: pivot.x + sim.tx - (cos * pivot.x - sin * pivot.y),
    f: pivot.y + sim.ty - (sin * pivot.x + cos * pivot.y),
  }
}

export function affineToArray(m: Affine): [number, number, number, number, number, number] {
  return [m.a, m.b, m.c, m.d, m.e, m.f]
}

/** Rotates v by θ (image coordinates). */
export function rotate(v: Vec2, theta: number): Vec2 {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y }
}
