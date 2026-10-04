import { IDENTITY, invert, multiply, type Affine } from '../geometry/affine'

export type Rotation = 0 | 90 | 180 | 270

/** Planar YUV layout of a WebCodecs pixel format. */
export interface YuvLayout {
  bits: 8 | 10 | 12
  /** Chroma subsampling factors. */
  subX: 1 | 2
  subY: 1 | 2
  /** NV12: U and V interleaved in a single plane. */
  interleaved: boolean
}

/** YUV formats whose planes can be processed directly; null for RGB or opaque (GPU-only) frames. */
export function yuvLayout(format: string | null | undefined): YuvLayout | null {
  if (format === 'NV12') return { bits: 8, subX: 2, subY: 2, interleaved: true }
  const m = /^I4(20|22|44)A?(P10|P12)?$/.exec(format ?? '')
  if (!m) return null
  const bits = m[2] === 'P10' ? 10 : m[2] === 'P12' ? 12 : 8
  const sub = m[1] === '20' ? ([2, 2] as const) : m[1] === '22' ? ([2, 1] as const) : ([1, 1] as const)
  return { bits, subX: sub[0], subY: sub[1], interleaved: false }
}

export function isRgbFormat(format: string | null | undefined): boolean {
  return format === 'RGBA' || format === 'RGBX' || format === 'BGRA' || format === 'BGRX'
}

/** Output pixel format for 4:2:0 frames at a bit depth. */
export function i420Format(bits: 8 | 10 | 12): 'I420' | 'I420P10' | 'I420P12' {
  return bits === 8 ? 'I420' : bits === 10 ? 'I420P10' : 'I420P12'
}

/**
 * Maps continuous coordinates of a stored (coded) image of size w×h to display coordinates: pixel
 * aspect scaling first, then clockwise rotation, then a horizontal flip — the order used by the
 * container metadata (and Mediabunny).
 */
export function codedToDisplay(
  w: number,
  h: number,
  rotation: Rotation,
  flip: boolean,
  scaleX = 1,
  scaleY = 1,
): Affine {
  const sw = w * scaleX
  const sh = h * scaleY
  const S: Affine = { a: scaleX, b: 0, c: 0, d: scaleY, e: 0, f: 0 }
  let R: Affine
  switch (rotation) {
    case 90: // (x, y) → (sh − y, x)
      R = { a: 0, b: 1, c: -1, d: 0, e: sh, f: 0 }
      break
    case 180: // (x, y) → (sw − x, sh − y)
      R = { a: -1, b: 0, c: 0, d: -1, e: sw, f: sh }
      break
    case 270: // (x, y) → (y, sw − x)
      R = { a: 0, b: -1, c: 1, d: 0, e: 0, f: sw }
      break
    default:
      R = IDENTITY
  }
  const displayWidth = rotation % 180 === 0 ? sw : sh
  const F: Affine = flip ? { a: -1, b: 0, c: 0, d: 1, e: displayWidth, f: 0 } : IDENTITY
  return multiply(F, multiply(R, S))
}

/** Stored size for a given display size (undoing a 90°/270° rotation). */
export function storedSize(displayWidth: number, displayHeight: number, rotation: Rotation): { width: number; height: number } {
  return rotation % 180 === 0
    ? { width: displayWidth, height: displayHeight }
    : { width: displayHeight, height: displayWidth }
}

/**
 * Chroma plane → luma continuous coordinates. Horizontally subsampled chroma is co-sited with the
 * left luma sample (MPEG-2/H.264/HEVC default); vertically subsampled chroma sits between rows.
 */
export function planeToLuma(subX: 1 | 2, subY: 1 | 2): Affine {
  return { a: subX, b: 0, c: 0, d: subY, e: subX === 2 ? -0.5 : 0, f: 0 }
}

/**
 * Sampling matrix for one output plane: output plane coordinates → input plane coordinates, given
 * `inv` (output luma → input luma) and each plane's subsampling.
 */
export function planeSamplingMatrix(inv: Affine, outSub: [1 | 2, 1 | 2], inSub: [1 | 2, 1 | 2]): Affine {
  return multiply(invert(planeToLuma(inSub[0], inSub[1])), multiply(inv, planeToLuma(outSub[0], outSub[1])))
}

/** Luma and chroma coefficients of a YUV matrix (BT.709 when unknown). */
export function matrixCoefficients(matrix: string | null | undefined): { kr: number; kb: number } {
  switch (matrix) {
    case 'bt470bg':
    case 'smpte170m':
      return { kr: 0.299, kb: 0.114 }
    case 'bt2020-ncl':
      return { kr: 0.2627, kb: 0.0593 }
    default:
      return { kr: 0.2126, kb: 0.0722 }
  }
}

/** Black (Y) and neutral chroma code values. */
export function blackLevels(bits: number, fullRange: boolean): { y: number; c: number } {
  const scale = 1 << (bits - 8)
  return { y: fullRange ? 0 : 16 * scale, c: 128 * scale }
}
