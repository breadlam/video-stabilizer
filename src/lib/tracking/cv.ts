/**
 * Minimal typings for the subset of OpenCV.js used by the tracker, plus a loader that works with
 * both the promise-style and callback-style builds of `@techstark/opencv-js`.
 */

export interface Point {
  x: number
  y: number
}

export interface Mat {
  readonly rows: number
  readonly cols: number
  readonly data: Uint8Array
  readonly data32F: Float32Array
  readonly data64F: Float64Array
  roi(rect: unknown): Mat
  clone(): Mat
  delete(): void
  isDeleted(): boolean
}

export interface CV {
  Mat: { new (): Mat; new (rows: number, cols: number, type: number): Mat }
  Rect: new (x: number, y: number, width: number, height: number) => unknown
  Size: new (width: number, height: number) => unknown
  TermCriteria: new (type: number, maxCount: number, epsilon: number) => unknown
  matFromArray(rows: number, cols: number, type: number, data: number[]): Mat
  matFromImageData(image: { data: Uint8ClampedArray; width: number; height: number }): Mat
  cvtColor(src: Mat, dst: Mat, code: number): void
  matchTemplate(image: Mat, templ: Mat, result: Mat, method: number): void
  minMaxLoc(src: Mat): { minVal: number; maxVal: number; minLoc: Point; maxLoc: Point }
  findTransformECC(
    templateImage: Mat,
    inputImage: Mat,
    warpMatrix: Mat,
    motionType: number,
    criteria: unknown,
    inputMask: Mat,
    gaussFiltSize: number,
  ): number
  warpAffine(src: Mat, dst: Mat, M: Mat, dsize: unknown, flags: number, borderMode: number): void
  resize(src: Mat, dst: Mat, dsize: unknown, fx: number, fy: number, interpolation: number): void
  GaussianBlur(src: Mat, dst: Mat, ksize: unknown, sigmaX: number): void
  CV_8UC1: number
  CV_8UC4: number
  CV_32F: number
  CV_64F: number
  COLOR_RGBA2GRAY: number
  TM_CCOEFF_NORMED: number
  MOTION_TRANSLATION: number
  MOTION_EUCLIDEAN: number
  TermCriteria_COUNT: number
  TermCriteria_EPS: number
  INTER_LINEAR: number
  INTER_AREA: number
  INTER_LANCZOS4: number
  WARP_INVERSE_MAP: number
  BORDER_REPLICATE: number
}

/** Resolves the OpenCV.js module object once its WebAssembly runtime is ready. */
export async function resolveOpenCv(mod: unknown): Promise<CV> {
  const m = mod as { default?: unknown }
  let cv = (m && typeof m === 'object' && 'default' in m && m.default ? m.default : mod) as
    | (CV & { onRuntimeInitialized?: () => void; then?: unknown })
    | Promise<CV>
  if (cv instanceof Promise || typeof (cv as { then?: unknown }).then === 'function') {
    cv = await (cv as Promise<CV>)
  }
  const c = cv as CV & { onRuntimeInitialized?: () => void }
  if (!c.Mat) await new Promise<void>((resolve) => (c.onRuntimeInitialized = resolve))
  return c
}
