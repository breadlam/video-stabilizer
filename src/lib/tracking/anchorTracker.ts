import type { Vec2 } from '../geometry/affine'
import type { CV, Mat } from './cv'

/**
 * Pixel access to one decoded frame. Implemented over a canvas in the browser and over a cv.Mat in
 * tests, so the tracker itself is environment-agnostic.
 *
 * Coordinates are continuous: pixel i covers [i, i+1).
 */
export interface FrameAccess {
  readonly width: number
  readonly height: number
  /**
   * Returns an 8-bit grayscale image of outW×outH pixels in which continuous coordinate u corresponds
   * to frame coordinate x0 + u / scale. The caller owns (and must delete) the Mat. The region lies
   * inside the frame.
   */
  readGray(x0: number, y0: number, outW: number, outH: number, scale: number): Mat
}

export interface TrackerParams {
  /** Search radius around the predicted position, in frame pixels. */
  searchRadius: number
  /** Correlation below which a match is considered unreliable. */
  minScore: number
  /** Estimate the anchor's rotation (Euclidean ECC) in addition to its position. */
  rotation: boolean
}

export interface Measurement {
  x: number
  y: number
  /** Rotation relative to the reference frame, radians. */
  angle: number
  score: number
}

/** Largest template side we track at; bigger anchors are tracked on a down-scaled image. */
export const MAX_TEMPLATE_SIDE = 160
const MIN_TEMPLATE_SIDE = 8
/** Extra context kept around the template so it can be rotated, as a fraction of its larger side. */
const MARGIN_FRACTION = 0.3
/** Coarse whole-frame search works on an image whose larger side is about this many pixels. */
const GLOBAL_SEARCH_SIDE = 480
const HALF: Vec2 = { x: 0.5, y: 0.5 }

export interface Template {
  /** Template plus margin, at tracker scale. */
  patch: Mat
  /** Unrotated template (tw×th), at tracker scale. */
  base: Mat
  /** Template's offset inside `patch`. */
  ml: number
  mt: number
  /** Anchor point in template coordinates (continuous, tracker scale). */
  cs: Vec2
  /** Rotation of the frame the template was captured from, relative to the reference. */
  angleOffset: number
  /** Persistent templates are never released by `use`; their owner releases them. */
  persistent: boolean
}

/** Tracks one anchor: template capture, local search (NCC → ECC) and whole-frame re-acquisition. */
export class AnchorTracker {
  /** Tracker scale: frame pixels × scale = tracker pixels. */
  readonly scale: number
  readonly tw: number
  readonly th: number
  private template: Template | null = null

  constructor(
    private readonly cv: CV,
    boxWidth: number,
    boxHeight: number,
    private readonly params: TrackerParams,
  ) {
    this.scale = Math.min(1, MAX_TEMPLATE_SIDE / Math.max(boxWidth, boxHeight))
    this.tw = Math.max(MIN_TEMPLATE_SIDE, Math.round(boxWidth * this.scale))
    this.th = Math.max(MIN_TEMPLATE_SIDE, Math.round(boxHeight * this.scale))
  }

  get current(): Template | null {
    return this.template
  }

  /**
   * Captures a template whose anchor point is `center` in `frame`. The template is shifted inwards
   * if it would leave the frame. Returns the new template; the caller decides whether to keep the
   * previous one (see `use`).
   */
  capture(frame: FrameAccess, center: Vec2, angleOffset: number, persistent = false): Template {
    const { cv, scale: s, tw, th } = this
    const twF = tw / s
    const thF = th / s
    if (twF > frame.width || thF > frame.height) throw new Error('Anchor is larger than the frame')
    let tlx = center.x - twF / 2
    let tly = center.y - thF / 2
    if (s === 1) {
      tlx = Math.round(tlx)
      tly = Math.round(tly)
    }
    tlx = clamp(tlx, 0, frame.width - twF)
    tly = clamp(tly, 0, frame.height - thF)

    const margin = this.params.rotation ? Math.ceil(MARGIN_FRACTION * Math.max(tw, th)) : 0
    const ml = Math.min(margin, Math.floor(tlx * s))
    const mt = Math.min(margin, Math.floor(tly * s))
    const mr = Math.min(margin, Math.floor((frame.width - tlx - twF) * s))
    const mb = Math.min(margin, Math.floor((frame.height - tly - thF) * s))

    const patch = frame.readGray(tlx - ml / s, tly - mt / s, tw + ml + mr, th + mt + mb, s)
    const view = patch.roi(new cv.Rect(ml, mt, tw, th))
    const base = view.clone()
    view.delete()
    return {
      patch,
      base,
      ml,
      mt,
      cs: { x: (center.x - tlx) * s, y: (center.y - tly) * s },
      angleOffset,
      persistent,
    }
  }

  /** Makes `t` the active template, releasing the previous one unless it is persistent. */
  use(t: Template): void {
    if (this.template && this.template !== t && !this.template.persistent) releaseTemplate(this.template)
    this.template = t
  }

  /**
   * Searches for the anchor within `radius` frame pixels of `predicted`. Returns null when the search
   * window does not fit inside the frame.
   */
  measure(frame: FrameAccess, predicted: Vec2, predictedAngle: number, radius: number): Measurement | null {
    const t = this.template
    if (!t) throw new Error('No template')
    const { cv, scale: s, tw, th } = this
    const phi = this.params.rotation ? predictedAngle - t.angleOffset : 0

    // Window (frame pixels) that contains the rotated template anywhere within `radius`.
    const extX = Math.max(t.cs.x, tw - t.cs.x, t.cs.y, th - t.cs.y) / s
    const reach = (this.params.rotation ? Math.SQRT2 * extX : extX) + radius + 2
    const x0 = Math.max(0, Math.floor(predicted.x - reach))
    const y0 = Math.max(0, Math.floor(predicted.y - reach))
    const x1 = Math.min(frame.width, Math.ceil(predicted.x + reach))
    const y1 = Math.min(frame.height, Math.ceil(predicted.y + reach))
    const outW = Math.floor((x1 - x0) * s)
    const outH = Math.floor((y1 - y0) * s)
    if (outW < tw + 2 || outH < th + 2) return null

    const win = frame.readGray(x0, y0, outW, outH, s)
    const rotated = Math.abs(phi) > 1e-3 ? this.rotatedTemplate(t, phi) : null
    const result = new cv.Mat()
    try {
      cv.matchTemplate(win, rotated ?? t.base, result, cv.TM_CCOEFF_NORMED)
      const { maxVal, maxLoc } = cv.minMaxLoc(result)
      const sub = parabolicPeak(result, maxLoc.x, maxLoc.y)
      let cx = maxLoc.x + sub.x + t.cs.x
      let cy = maxLoc.y + sub.y + t.cs.y
      let angle = phi
      let score = maxVal

      const ecc = this.refineEcc(win, t, { x: cx, y: cy }, phi)
      const tolerance = Math.max(1.5, 0.1 * Math.max(tw, th))
      if (ecc && Math.hypot(ecc.x - cx, ecc.y - cy) <= tolerance) {
        cx = ecc.x
        cy = ecc.y
        angle = ecc.angle
        score = Math.max(score, ecc.score)
      }
      return { x: x0 + cx / s, y: y0 + cy / s, angle: angle + t.angleOffset, score }
    } finally {
      win.delete()
      rotated?.delete()
      result.delete()
    }
  }

  /**
   * Coarse search over the whole frame (down-scaled) followed by a local refinement. Used to find
   * the anchor when there is no usable prediction. Returns null if the template is too small to
   * search at the coarse scale.
   */
  reacquire(frame: FrameAccess, predictedAngle: number): Measurement | null {
    const t = this.template
    if (!t) throw new Error('No template')
    const { cv, scale: s } = this
    const g = Math.min(s, GLOBAL_SEARCH_SIDE / Math.max(frame.width, frame.height))
    const ratio = g / s
    const sw = Math.round(this.tw * ratio)
    const sh = Math.round(this.th * ratio)
    if (sw < MIN_TEMPLATE_SIDE || sh < MIN_TEMPLATE_SIDE) return null

    const phi = this.params.rotation ? predictedAngle - t.angleOffset : 0
    const rotated = Math.abs(phi) > 1e-3 ? this.rotatedTemplate(t, phi) : null
    const small = new cv.Mat()
    const result = new cv.Mat()
    const whole = frame.readGray(0, 0, Math.floor(frame.width * g), Math.floor(frame.height * g), g)
    try {
      cv.resize(rotated ?? t.base, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA)
      if (whole.cols <= sw || whole.rows <= sh) return null
      cv.matchTemplate(whole, small, result, cv.TM_CCOEFF_NORMED)
      const { maxLoc } = cv.minMaxLoc(result)
      const guess = {
        x: (maxLoc.x + (t.cs.x * sw) / this.tw) / g,
        y: (maxLoc.y + (t.cs.y * sh) / this.th) / g,
      }
      return this.measure(frame, guess, predictedAngle, 2 / g + 4)
    } finally {
      rotated?.delete()
      small.delete()
      result.delete()
      whole.delete()
    }
  }

  /** Releases the active template unless it is persistent. */
  dispose(): void {
    if (this.template && !this.template.persistent) releaseTemplate(this.template)
    this.template = null
  }

  /** The template as it would appear rotated by φ about its anchor point. */
  private rotatedTemplate(t: Template, phi: number): Mat {
    const { cv } = this
    // Inverse map in pixel coordinates (pixel centres at integers):
    //   src = R(−φ)·(u + ½ − cs) + cs + (ml, mt) − ½
    const c = Math.cos(phi)
    const sn = Math.sin(phi)
    const ux = HALF.x - t.cs.x
    const uy = HALF.y - t.cs.y
    const bx = c * ux + sn * uy + t.cs.x + t.ml - HALF.x
    const by = -sn * ux + c * uy + t.cs.y + t.mt - HALF.y
    const M = cv.matFromArray(2, 3, cv.CV_64F, [c, sn, bx, -sn, c, by])
    const out = new cv.Mat()
    cv.warpAffine(
      t.patch,
      out,
      M,
      new cv.Size(this.tw, this.th),
      cv.INTER_LINEAR | cv.WARP_INVERSE_MAP,
      cv.BORDER_REPLICATE,
    )
    M.delete()
    return out
  }

  /**
   * Sub-pixel alignment of the unrotated template to the window with ECC, starting from the coarse
   * anchor position `c` (window coordinates) and rotation φ. Returns null if ECC does not converge.
   */
  private refineEcc(win: Mat, t: Template, c: Vec2, phi: number): Measurement | null {
    const { cv } = this
    const rotation = this.params.rotation
    const cos = rotation ? Math.cos(phi) : 1
    const sin = rotation ? Math.sin(phi) : 0
    // Warp maps template pixel coords → window pixel coords: W(u) = R·u + b, chosen so that the
    // anchor point lands on c:  b = R·(½ − cs) + c − ½.
    const px = HALF.x - t.cs.x
    const py = HALF.y - t.cs.y
    const bx = cos * px - sin * py + c.x - HALF.x
    const by = sin * px + cos * py + c.y - HALF.y
    const warp = cv.matFromArray(2, 3, cv.CV_32F, [cos, -sin, bx, sin, cos, by])
    const mask = new cv.Mat()
    try {
      const criteria = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 50, 1e-4)
      const score = cv.findTransformECC(
        t.base,
        win,
        warp,
        rotation ? cv.MOTION_EUCLIDEAN : cv.MOTION_TRANSLATION,
        criteria,
        mask,
        3,
      )
      const w = warp.data32F
      const qx = t.cs.x - HALF.x
      const qy = t.cs.y - HALF.y
      const x = w[0] * qx + w[1] * qy + w[2] + HALF.x
      const y = w[3] * qx + w[4] * qy + w[5] + HALF.y
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(score)) return null
      return { x, y, angle: rotation ? Math.atan2(w[3], w[0]) : 0, score }
    } catch {
      // ECC throws when it fails to converge; the coarse match is used instead.
      return null
    } finally {
      warp.delete()
      mask.delete()
    }
  }
}

export function releaseTemplate(t: Template): void {
  t.patch.delete()
  t.base.delete()
}

/** Sub-pixel offset of a correlation peak from a 1-D parabola fit in each axis. */
function parabolicPeak(result: Mat, x: number, y: number): Vec2 {
  const w = result.cols
  const h = result.rows
  const d = result.data32F
  const at = (i: number, j: number) => d[j * w + i]
  const fit = (a: number, b: number, c: number) => {
    const den = a - 2 * b + c
    return den < 0 ? clamp((a - c) / (2 * den), -0.5, 0.5) : 0
  }
  return {
    x: x > 0 && x < w - 1 ? fit(at(x - 1, y), at(x, y), at(x + 1, y)) : 0,
    y: y > 0 && y < h - 1 ? fit(at(x, y - 1), at(x, y), at(x, y + 1)) : 0,
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}
