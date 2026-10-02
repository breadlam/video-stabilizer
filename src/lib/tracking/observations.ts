/** Per-frame, per-anchor tracking results, stored in flat typed arrays (cheap to transfer and keep). */

export const Status = {
  /** Not tracked (yet). */
  None: 0,
  /** Found with good confidence. */
  Ok: 1,
  /** Reference frame or user correction. */
  Key: 2,
  /** Best match was below the confidence threshold; excluded from the solve. */
  Low: 3,
  /** Not found (out of frame or no candidate). */
  Lost: 4,
} as const
export type Status = (typeof Status)[keyof typeof Status]

export interface AnchorObs {
  x: number
  y: number
  /** Patch rotation relative to the reference frame, radians. */
  angle: number
  score: number
  status: Status
}

export function isUsable(status: number): boolean {
  return status === Status.Ok || status === Status.Key
}

/** A contiguous run of frames, used to stream results from the tracking worker. */
export interface ObsBatch {
  start: number
  count: number
  x: Float64Array
  y: Float64Array
  angle: Float32Array
  score: Float32Array
  status: Uint8Array
}

export class Observations {
  readonly x: Float64Array
  readonly y: Float64Array
  readonly angle: Float32Array
  readonly score: Float32Array
  readonly status: Uint8Array

  constructor(
    readonly frames: number,
    readonly anchors: number,
  ) {
    const n = frames * anchors
    this.x = new Float64Array(n)
    this.y = new Float64Array(n)
    this.angle = new Float32Array(n)
    this.score = new Float32Array(n)
    this.status = new Uint8Array(n)
  }

  get(frame: number, anchor: number): AnchorObs {
    const i = frame * this.anchors + anchor
    return {
      x: this.x[i],
      y: this.y[i],
      angle: this.angle[i],
      score: this.score[i],
      status: this.status[i] as Status,
    }
  }

  set(frame: number, anchor: number, o: AnchorObs): void {
    const i = frame * this.anchors + anchor
    this.x[i] = o.x
    this.y[i] = o.y
    this.angle[i] = o.angle
    this.score[i] = o.score
    this.status[i] = o.status
  }

  statusAt(frame: number, anchor: number): Status {
    return this.status[frame * this.anchors + anchor] as Status
  }

  /** Copies a batch produced by `toBatch` (possibly in another thread) into this store. */
  writeBatch(b: ObsBatch): void {
    const o = b.start * this.anchors
    this.x.set(b.x, o)
    this.y.set(b.y, o)
    this.angle.set(b.angle, o)
    this.score.set(b.score, o)
    this.status.set(b.status, o)
  }

  toBatch(start: number, count: number): ObsBatch {
    const a = start * this.anchors
    const z = (start + count) * this.anchors
    return {
      start,
      count,
      x: this.x.slice(a, z),
      y: this.y.slice(a, z),
      angle: this.angle.slice(a, z),
      score: this.score.slice(a, z),
      status: this.status.slice(a, z),
    }
  }

  /** Marks every frame from `start` on as untracked. */
  clearFrom(start: number): void {
    this.status.fill(Status.None, start * this.anchors)
  }

  /** Number of frames whose status for any anchor is not None, scanning from the start. */
  trackedPrefix(): number {
    for (let f = 0; f < this.frames; f++) {
      for (let a = 0; a < this.anchors; a++) {
        if (this.status[f * this.anchors + a] === Status.None) return f
      }
    }
    return this.frames
  }
}
