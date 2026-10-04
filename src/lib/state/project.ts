import type { Rect } from '../geometry/crop'
import type { MotionModel } from '../geometry/trajectory'
import type { EdgeFill, ExportQuality } from '../media/exportProtocol'
import type { VideoInfo } from '../media/video'
import { Observations } from '../tracking/observations'

export interface Anchor {
  id: number
  color: string
  rect: Rect
}

export interface Correction {
  anchorId: number
  index: number
  x: number
  y: number
}

export interface Settings {
  model: MotionModel
  /** Search radius in frame pixels. */
  searchRadius: number
  minScore: number
  /** Jitter filter sigma in frames (0 = off). */
  smoothing: number
  zoomMode: 'auto' | 'manual'
  zoom: number
  fill: EdgeFill
  /** Output frame size: the source's, or the crop at its native resolution (no upscaling). */
  outputSize: 'source' | 'native'
  quality: ExportQuality
}

export interface ProjectData {
  refIndex: number
  anchors: Anchor[]
  corrections: Correction[]
  settings: Settings
  obs: Observations | null
  trackedUpTo: number
}

const FORMAT = 'anchor-stabilizer-project'
const VERSION = 1

interface ProjectFile {
  format: typeof FORMAT
  version: number
  video: { name: string; size: number; width: number; height: number; frames: number }
  refIndex: number
  anchors: Anchor[]
  corrections: Correction[]
  settings: Settings
  tracking: null | {
    trackedUpTo: number
    x: string
    y: string
    angle: string
    score: string
    status: string
  }
}

function toBase64(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function serializeProject(info: VideoInfo, p: ProjectData): string {
  const file: ProjectFile = {
    format: FORMAT,
    version: VERSION,
    video: { name: info.name, size: info.size, width: info.width, height: info.height, frames: info.timestamps.length },
    refIndex: p.refIndex,
    anchors: p.anchors,
    corrections: p.corrections,
    settings: p.settings,
    tracking: p.obs
      ? {
          trackedUpTo: p.trackedUpTo,
          x: toBase64(p.obs.x),
          y: toBase64(p.obs.y),
          angle: toBase64(p.obs.angle),
          score: toBase64(p.obs.score),
          status: toBase64(p.obs.status),
        }
      : null,
  }
  return JSON.stringify(file)
}

export class ProjectMismatchError extends Error {}

/** Parses a project file for the given video. Throws if it belongs to a different video. */
export function parseProject(text: string, info: VideoInfo): ProjectData {
  const f = JSON.parse(text) as ProjectFile
  if (f.format !== FORMAT || f.version !== VERSION) throw new Error('Not an Anchor Stabilizer project file.')
  const frames = info.timestamps.length
  if (f.video.frames !== frames || f.video.width !== info.width || f.video.height !== info.height) {
    throw new ProjectMismatchError(
      `This project was made for "${f.video.name}" (${f.video.width}×${f.video.height}, ${f.video.frames} frames), ` +
        `not the open video (${info.width}×${info.height}, ${frames} frames).`,
    )
  }
  let obs: Observations | null = null
  if (f.tracking) {
    obs = new Observations(frames, f.anchors.length)
    obs.x.set(new Float64Array(fromBase64(f.tracking.x).buffer))
    obs.y.set(new Float64Array(fromBase64(f.tracking.y).buffer))
    obs.angle.set(new Float32Array(fromBase64(f.tracking.angle).buffer))
    obs.score.set(new Float32Array(fromBase64(f.tracking.score).buffer))
    obs.status.set(fromBase64(f.tracking.status))
  }
  return {
    refIndex: f.refIndex,
    anchors: f.anchors,
    corrections: f.corrections,
    settings: f.settings,
    obs,
    trackedUpTo: f.tracking?.trackedUpTo ?? 0,
  }
}
