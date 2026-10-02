import { multiply, scaling, translation, type Affine } from '../geometry/affine'
import type { Rect } from '../geometry/crop'

/** Source-frame pixels → output pixels, given the stabilizing warp (frame → reference) and the crop. */
export function outputMatrix(toRef: Affine, crop: Rect, outWidth: number, outHeight: number): Affine {
  return multiply(scaling(outWidth / crop.w, outHeight / crop.h), multiply(translation(-crop.x, -crop.y), toRef))
}

/** Packs per-frame output matrices for transfer to the export worker. */
export function packMatrices(toRef: readonly Affine[], crop: Rect, outWidth: number, outHeight: number): Float64Array {
  const out = new Float64Array(toRef.length * 6)
  toRef.forEach((m, i) => {
    const o = outputMatrix(m, crop, outWidth, outHeight)
    out.set([o.a, o.b, o.c, o.d, o.e, o.f], i * 6)
  })
  return out
}

/**
 * Draws `image` through `m` (with an extra `view` transform for display scaling). With
 * `clear`, the destination is filled with black first; otherwise previous pixels show through
 * uncovered areas.
 */
export function drawThrough(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  image: CanvasImageSource,
  m: Affine,
  clear: boolean,
): void {
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (clear) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f)
  ctx.drawImage(image, 0, 0)
  ctx.restore()
}

/** Even dimensions (required by most encoders). */
export function evenSize(width: number, height: number): { width: number; height: number } {
  return { width: Math.max(2, Math.floor(width / 2) * 2), height: Math.max(2, Math.floor(height / 2) * 2) }
}
