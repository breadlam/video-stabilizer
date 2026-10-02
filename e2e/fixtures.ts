import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply, invert, multiply, type Affine, type Vec2 } from '../src/lib/geometry/affine'
import type { CV, Mat } from '../src/lib/tracking/cv'
import { driftPath, loadCv, makeTexture, renderVideo } from '../tests/helpers'

export interface DriftVideo {
  path: string
  width: number
  height: number
  frames: number
  fps: number
  /** Camera motion per frame (reference → frame), reference = frame 0. */
  motion: Affine[]
}

const ROOT = join(import.meta.dirname, '..', 'test-results', 'fixtures')

/** Per-project output directory, so parallel browser projects never write the same files. */
export function outDir(project: string): string {
  const dir = join(ROOT, project)
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface DriftOptions {
  /** Output directory (see `outDir`). */
  dir: string
  width?: number
  height?: number
  frames?: number
  roll?: number
  /** Covers this region (reference-frame coordinates, moving with the scene) on the given frames. */
  occlude?: { from: number; to: number; rect: { x: number; y: number; w: number; h: number } }
  /** Display rotation metadata (degrees) written into the container, like portrait phone videos. */
  displayRotation?: number
}

/**
 * Renders a textured scene seen by a drifting, rolling camera and encodes it as H.264 MP4 with a
 * sine-wave audio track. Ground truth motion is returned alongside.
 */
export async function makeDriftVideo(name: string, opts: DriftOptions): Promise<DriftVideo> {
  const cv = await loadCv()
  const { width = 640, height = 360, frames = 90, roll = 0.03 } = opts
  const fps = 30
  const texture = makeTexture(cv, width + 240, height + 240, 3)
  const sims = driftPath(frames, { amplitude: 30, roll })
  const video = renderVideo(cv, texture, width, height, { x: 120, y: 120 }, sims, 1.5)
  texture.delete()
  const back = invert(video.motion[0])
  const motion = video.motion.map((M) => multiply(M, back))
  if (opts.occlude) {
    const { from, to, rect } = opts.occlude
    for (let f = from; f < to; f++) {
      const c = apply(motion[f], { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 })
      const m = video.frames[f]
      for (let y = Math.max(0, Math.round(c.y - rect.h / 2)); y < Math.min(height, Math.round(c.y + rect.h / 2)); y++) {
        const x0 = Math.max(0, Math.round(c.x - rect.w / 2))
        const x1 = Math.min(width, Math.round(c.x + rect.w / 2))
        m.data.fill(70, y * width + x0, y * width + x1)
      }
    }
  }

  const path = join(opts.dir, opts.displayRotation ? `raw-${name}` : name)
  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0',
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${frames / fps}`,
      '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', '-g', '30',
      '-c:a', 'aac', '-b:a', '96k',
      '-shortest', '-movflags', '+faststart',
      path,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  )
  for (const f of video.frames) {
    if (!ff.stdin.write(Buffer.from(f.data))) await new Promise((r) => ff.stdin.once('drain', r))
  }
  ff.stdin.end()
  await new Promise<void>((resolve, reject) => ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))))
  video.dispose()
  if (!existsSync(path)) throw new Error('ffmpeg did not produce the fixture')
  if (opts.displayRotation) {
    const rotated = join(opts.dir, name)
    const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-display_rotation', String(opts.displayRotation), '-i', path, '-c', 'copy', rotated])
    if (r.status !== 0) throw new Error(r.stderr.toString())
    return { path: rotated, width, height, frames, fps, motion }
  }
  return { path, width, height, frames, fps, motion }
}

export function truthAt(v: DriftVideo, frame: number, ref: Vec2): Vec2 {
  return apply(v.motion[frame], ref)
}

export interface ProbeResult {
  streams: { codec_type: string; codec_name: string; width?: number; height?: number; nb_frames?: string }[]
}

export function probe(path: string): ProbeResult {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout) as ProbeResult
}

/** Decodes a video to 8-bit grayscale frames. */
export function decodeGray(path: string, width: number, height: number): Uint8Array[] {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], {
    maxBuffer: 1 << 30,
  })
  if (r.status !== 0) throw new Error(r.stderr.toString())
  const size = width * height
  const out: Uint8Array[] = []
  for (let o = 0; o + size <= r.stdout.length; o += size) out.push(new Uint8Array(r.stdout.subarray(o, o + size)))
  return out
}

/**
 * Sub-pixel displacement of the patch `rect` of `ref` inside `img` (NCC + parabolic peak), searching
 * ±radius pixels.
 */
export function patchShift(
  cv: CV,
  ref: Uint8Array,
  img: Uint8Array,
  width: number,
  height: number,
  rect: { x: number; y: number; w: number; h: number },
  radius: number,
): { dx: number; dy: number; score: number } {
  const toMat = (data: Uint8Array): Mat => {
    const m = new cv.Mat(height, width, cv.CV_8UC1)
    m.data.set(data)
    return m
  }
  const a = toMat(ref)
  const b = toMat(img)
  const tpl = a.roi(new cv.Rect(rect.x, rect.y, rect.w, rect.h))
  const win = b.roi(new cv.Rect(rect.x - radius, rect.y - radius, rect.w + 2 * radius, rect.h + 2 * radius))
  const res = new cv.Mat()
  cv.matchTemplate(win, tpl, res, cv.TM_CCOEFF_NORMED)
  const { maxLoc, maxVal } = cv.minMaxLoc(res)
  const d = res.data32F
  const w = res.cols
  const at = (x: number, y: number) => d[y * w + x]
  const peak = (l: number, c: number, r: number) => (l - r) / (2 * (l - 2 * c + r))
  const sx = maxLoc.x > 0 && maxLoc.x < w - 1 ? peak(at(maxLoc.x - 1, maxLoc.y), maxVal, at(maxLoc.x + 1, maxLoc.y)) : 0
  const sy =
    maxLoc.y > 0 && maxLoc.y < res.rows - 1 ? peak(at(maxLoc.x, maxLoc.y - 1), maxVal, at(maxLoc.x, maxLoc.y + 1)) : 0
  ;[a, b, tpl, win, res].forEach((m) => m.delete())
  return { dx: maxLoc.x + sx - radius, dy: maxLoc.y + sy - radius, score: maxVal }
}

export { loadCv, writeFileSync }
