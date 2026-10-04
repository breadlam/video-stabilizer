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
  streams: {
    codec_type: string
    codec_name: string
    width?: number
    height?: number
    nb_frames?: string
    side_data_list?: { rotation?: number }[]
  }[]
}

/** Display rotation of the video stream from its metadata (0 when none). */
export function videoRotation(path: string): number {
  const v = probe(path).streams.find((s) => s.codec_type === 'video')
  return v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0
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

export interface ColorVideoOptions {
  dir: string
  /** 'h264': 8-bit H.264 High in MP4 (BT.709); 'vp9-10': 10-bit VP9 profile 2 in WebM. */
  format: 'h264' | 'vp9-10'
  frames?: number
  roll?: number
}

/**
 * A noise-free colour scene seen by a drifting camera, rendered with Lanczos interpolation so every
 * frame is equally sharp. The stabilized version of any frame should equal frame 0 (where covered),
 * which makes end-to-end fidelity measurable.
 */
export async function makeColorDriftVideo(name: string, opts: ColorVideoOptions): Promise<DriftVideo> {
  const cv = await loadCv()
  const width = 640
  const height = 360
  const { frames = 60, roll = 0.02 } = opts
  const fps = 30
  const tw = width + 240
  const th = height + 240
  const luma = makeTexture(cv, tw, th, 3)
  const c1 = makeTexture(cv, tw, th, 11)
  const c2 = makeTexture(cv, tw, th, 17)
  const sims = driftPath(frames, { amplitude: 30, roll })
  const channels = [
    { tex: luma, mix: (l: number, a: number) => 0.75 * l + 0.45 * a - 20, other: c1 },
    { tex: luma, mix: (l: number) => l, other: luma },
    { tex: luma, mix: (l: number, b: number) => 0.7 * l + 0.5 * b - 25, other: c2 },
  ].map(({ tex, mix, other }) => {
    const m = new cv.Mat(th, tw, cv.CV_8UC1)
    for (let i = 0; i < m.data.length; i++) m.data[i] = Math.max(0, Math.min(255, Math.round(mix(tex.data[i], other.data[i]))))
    const v = renderVideo(cv, m, width, height, { x: 120, y: 120 }, sims, 0, 1, cv.INTER_LANCZOS4)
    m.delete()
    return v
  })
  ;[luma, c1, c2].forEach((m) => m.delete())
  const back = invert(channels[0].motion[0])
  const motion = channels[0].motion.map((M) => multiply(M, back))

  const path = join(opts.dir, name)
  const video =
    opts.format === 'h264'
      ? ['-c:v', 'libx264', '-preset', 'slow', '-crf', '8', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-g', '30']
      : ['-c:v', 'libvpx-vp9', '-profile:v', '2', '-pix_fmt', 'yuv420p10le', '-crf', '6', '-b:v', '0', '-g', '30']
  const audio = opts.format === 'h264' ? ['-c:a', 'aac', '-b:a', '128k'] : ['-c:a', 'libopus', '-b:a', '96k']
  const ff = spawn(
    'ffmpeg',
    [
      '-y', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0',
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${frames / fps}`,
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
      ...video,
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
      ...audio,
      '-shortest',
      path,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  )
  const rgb = Buffer.alloc(width * height * 3)
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < width * height; i++) {
      rgb[3 * i] = channels[0].frames[f].data[i]
      rgb[3 * i + 1] = channels[1].frames[f].data[i]
      rgb[3 * i + 2] = channels[2].frames[f].data[i]
    }
    if (!ff.stdin.write(Buffer.from(rgb))) await new Promise((r) => ff.stdin.once('drain', r))
  }
  ff.stdin.end()
  await new Promise<void>((resolve, reject) => ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))))
  channels.forEach((c) => c.dispose())
  return { path, width, height, frames, fps, motion }
}

export interface YuvFrame {
  y: Uint8Array | Uint16Array
  u: Uint8Array | Uint16Array
  v: Uint8Array | Uint16Array
}

/** Decodes to planar 4:2:0 at 8 or 10 bits (10-bit samples are little-endian 16-bit). */
export function decodeYuv(path: string, width: number, height: number, bits: 8 | 10 = 8): YuvFrame[] {
  const pixFmt = bits === 8 ? 'yuv420p' : 'yuv420p10le'
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', pixFmt, 'pipe:1'], { maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(r.stderr.toString())
  const bps = bits === 8 ? 1 : 2
  const ySize = width * height * bps
  const cSize = (width / 2) * (height / 2) * bps
  const frameSize = ySize + 2 * cSize
  const out: YuvFrame[] = []
  const buf = new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength).slice()
  for (let o = 0; o + frameSize <= buf.length; o += frameSize) {
    const view = (start: number, len: number) =>
      bits === 8 ? buf.subarray(o + start, o + start + len) : new Uint16Array(buf.buffer, o + start, len / 2)
    out.push({ y: view(0, ySize), u: view(ySize, cSize), v: view(ySize + cSize, cSize) })
  }
  return out
}

/** PSNR of two planes over a rectangle (plane coordinates). */
export function psnr(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  stride: number,
  rect: { x: number; y: number; w: number; h: number },
  maxValue: number,
): number {
  let se = 0
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const d = a[y * stride + x] - b[y * stride + x]
      se += d * d
    }
  }
  const mse = se / (rect.w * rect.h)
  return mse === 0 ? Infinity : 10 * Math.log10((maxValue * maxValue) / mse)
}

export interface VideoStreamInfo {
  codec_name: string
  profile?: string
  pix_fmt?: string
  width: number
  height: number
  color_range?: string
  color_space?: string
  color_transfer?: string
  color_primaries?: string
  nb_frames?: string
  bit_rate?: string
}

export function videoStream(path: string): VideoStreamInfo {
  return probe(path).streams.find((s) => s.codec_type === 'video') as unknown as VideoStreamInfo
}

/** Presentation timestamps (seconds) of the video stream, sorted. */
export function videoPts(path: string): number[] {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', path],
    { encoding: 'utf8' },
  )
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b)
}

/** MD5 of a stream's packets, copied without decoding (equal ⇔ bit-identical stream data). */
export function streamMd5(path: string, stream: 'a:0' | 'v:0'): string {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-map', `0:${stream}`, '-c', 'copy', '-f', 'md5', '-'], {
    encoding: 'utf8',
  })
  return r.stdout.trim()
}
