import type { Vec2 } from '../geometry/affine'
import { fitSimilarity, type Correspondence } from '../geometry/fit'
import type { Rect } from '../geometry/crop'
import {
  AnchorTracker,
  releaseTemplate,
  type FrameAccess,
  type Measurement,
  type Template,
  type TrackerParams,
} from './anchorTracker'
import type { CV } from './cv'
import { isUsable, Status, type AnchorObs } from './observations'

export interface Keyframe {
  anchor: number
  index: number
  x: number
  y: number
}

export interface SessionConfig {
  width: number
  height: number
  /** Anchor boxes on the reference frame (frame pixels). */
  anchors: Rect[]
  refIndex: number
  keyframes: Keyframe[]
  params: TrackerParams
}

/** Where an anchor's active template comes from when tracking resumes mid-video. */
export interface TemplateSource {
  index: number
  x: number
  y: number
  angle: number
}

export interface AnchorResume {
  /** null = the reference template. */
  template: TemplateSource | null
  /** Most recent good observations before the start frame, oldest first (at most two used). */
  history: { index: number; x: number; y: number }[]
}

export interface ResumeState {
  startIndex: number
  anchors: AnchorResume[]
  angle: number
}

interface AnchorState {
  tracker: AnchorTracker
  ref: Vec2
  /** The reference template, kept for the whole session. */
  refTemplate: Template | null
  history: { index: number; x: number; y: number }[]
  lost: number
}

/** Frames between whole-frame re-acquisition attempts while an anchor stays lost. */
const REACQUIRE_EVERY = 5

/** Score required for matches far from the prediction: halfway between minScore and 1. */
function strictScore(minScore: number): number {
  return minScore + (1 - minScore) / 2
}

/**
 * Runs all anchor trackers over a sequence of frames processed in increasing index order.
 * See docs/DESIGN.md, "Tracking".
 */
export class TrackSession {
  private readonly anchors: AnchorState[]
  private readonly keyframes = new Map<number, Keyframe[]>()
  private angle: number
  private readonly pendingTemplates = new Map<number, { anchor: number; source: TemplateSource | null }[]>()

  constructor(
    cv: CV,
    private readonly config: SessionConfig,
    resume?: ResumeState,
  ) {
    const { params } = config
    this.anchors = config.anchors.map((r, i) => ({
      tracker: new AnchorTracker(cv, r.w, r.h, params),
      ref: { x: r.x + r.w / 2, y: r.y + r.h / 2 },
      refTemplate: null,
      history: resume ? resume.anchors[i].history.slice(-2) : [],
      lost: 0,
    }))
    this.angle = params.rotation ? (resume?.angle ?? 0) : 0
    const start = resume?.startIndex ?? 0
    for (const k of config.keyframes) {
      if (k.index < start || k.index === config.refIndex) continue
      const list = this.keyframes.get(k.index) ?? []
      list.push(k)
      this.keyframes.set(k.index, list)
    }

    // Every anchor needs the reference template; anchors resuming from a correction also need that frame.
    this.addPending(config.refIndex, -1, null)
    resume?.anchors.forEach((a, i) => {
      if (a.template) this.addPending(a.template.index, i, a.template)
    })
  }

  /** Frames whose pixels must be supplied via `loadTemplates` before calling `process`. */
  templateFrames(): number[] {
    return [...this.pendingTemplates.keys()]
  }

  loadTemplates(index: number, frame: FrameAccess): void {
    for (const { anchor, source } of this.pendingTemplates.get(index) ?? []) {
      if (anchor === -1) {
        for (const a of this.anchors) {
          a.refTemplate = a.tracker.capture(frame, a.ref, 0, true)
          if (!a.tracker.current) a.tracker.use(a.refTemplate)
        }
      } else if (source) {
        const a = this.anchors[anchor]
        a.tracker.use(a.tracker.capture(frame, source, source.angle))
      }
    }
    this.pendingTemplates.delete(index)
  }

  process(index: number, frame: FrameAccess): AnchorObs[] {
    if (this.pendingTemplates.size > 0) throw new Error('Templates not loaded')
    const { minScore, searchRadius } = this.config.params
    const out: AnchorObs[] = []

    if (index === this.config.refIndex) {
      for (const a of this.anchors) {
        a.tracker.use(a.refTemplate!)
        a.history = [{ index, x: a.ref.x, y: a.ref.y }]
        a.lost = 0
        out.push({ x: a.ref.x, y: a.ref.y, angle: 0, score: 1, status: Status.Key })
      }
      this.angle = 0
      return out
    }

    const keys = this.keyframes.get(index)
    for (let i = 0; i < this.anchors.length; i++) {
      const a = this.anchors[i]
      const key = keys?.find((k) => k.anchor === i)
      if (key) {
        out.push(this.applyKeyframe(a, index, frame, key))
        continue
      }

      const predicted = this.predict(a, index)
      const radius = searchRadius * Math.min(1 + a.lost, 4) * (a.history.length ? 1 : 3)
      let m = a.tracker.measure(frame, predicted, this.angle, radius)
      const needsGlobal = !a.history.length || (a.lost >= 2 && (a.lost - 2) % REACQUIRE_EVERY === 0)
      if ((!m || m.score < minScore) && needsGlobal) {
        const g = a.tracker.reacquire(frame, this.angle)
        if (g && (!m || g.score > m.score)) m = g
      }
      // A match far from where the anchor should be must be more convincing: NCC can latch onto
      // strong edges (e.g. an occluder's corner) with moderate scores.
      const far = !!m && a.history.length > 0 && Math.hypot(m.x - predicted.x, m.y - predicted.y) > searchRadius
      out.push(this.record(a, index, m, far ? strictScore(minScore) : minScore))
    }

    this.updateAngle(out)
    return out
  }

  dispose(): void {
    for (const a of this.anchors) {
      a.tracker.dispose()
      if (a.refTemplate) releaseTemplate(a.refTemplate)
      a.refTemplate = null
    }
  }

  private addPending(index: number, anchor: number, source: TemplateSource | null): void {
    const list = this.pendingTemplates.get(index) ?? []
    list.push({ anchor, source })
    this.pendingTemplates.set(index, list)
  }

  private predict(a: AnchorState, index: number): Vec2 {
    const h = a.history
    if (!h.length) return a.ref
    const last = h[h.length - 1]
    if (h.length < 2) return last
    const prev = h[h.length - 2]
    const gap = last.index - prev.index
    if (gap <= 0 || gap > 3) return last
    // Damped constant velocity: drift is smooth, but shake makes full extrapolation overshoot.
    const k = (0.5 * (index - last.index)) / gap
    return { x: last.x + k * (last.x - prev.x), y: last.y + k * (last.y - prev.y) }
  }

  private record(a: AnchorState, index: number, m: Measurement | null, threshold: number): AnchorObs {
    if (!m) {
      a.lost++
      const p = a.history.at(-1) ?? a.ref
      return { x: p.x, y: p.y, angle: this.angle, score: 0, status: Status.Lost }
    }
    const ok = m.score >= threshold
    if (ok) {
      a.history.push({ index, x: m.x, y: m.y })
      if (a.history.length > 2) a.history.shift()
      a.lost = 0
    } else {
      a.lost++
    }
    return { x: m.x, y: m.y, angle: m.angle, score: m.score, status: ok ? Status.Ok : Status.Low }
  }

  /**
   * A user correction: the hint is snapped to the best match of the current template nearby (if
   * any), then a fresh template is captured there.
   */
  private applyKeyframe(a: AnchorState, index: number, frame: FrameAccess, key: Keyframe): AnchorObs {
    const radius = Math.max(4, 0.25 * Math.max(a.tracker.tw, a.tracker.th) / a.tracker.scale)
    const m = a.tracker.measure(frame, key, this.angle, radius)
    const good = m && m.score >= this.config.params.minScore
    const pos = good ? { x: m.x, y: m.y } : { x: key.x, y: key.y }
    const angle = good ? m.angle : this.angle
    a.tracker.use(a.tracker.capture(frame, pos, this.config.params.rotation ? angle : 0))
    a.history = [{ index, ...pos }]
    a.lost = 0
    return { x: pos.x, y: pos.y, angle, score: 1, status: Status.Key }
  }

  /** Rotation prediction for the next frame. */
  private updateAngle(obs: AnchorObs[]): void {
    if (!this.config.params.rotation) return
    const usable = obs.map((o, i) => ({ o, i })).filter(({ o }) => isUsable(o.status))
    if (this.anchors.length === 1) {
      if (usable.length) this.angle = usable[0].o.angle
      return
    }
    if (usable.length < 2) return
    const pairs: Correspondence[] = usable.map(({ o, i }) => ({
      from: this.anchors[i].ref,
      to: { x: o.x, y: o.y },
      weight: Math.max(0.05, o.score),
    }))
    const sim = fitSimilarity(pairs, { x: this.config.width / 2, y: this.config.height / 2 })
    if (sim) this.angle = sim.theta
  }
}
