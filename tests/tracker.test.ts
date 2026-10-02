import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply, invert, multiply, type Similarity, type Vec2 } from '../src/lib/geometry/affine'
import type { Rect } from '../src/lib/geometry/crop'
import { solveTrajectory } from '../src/lib/geometry/trajectory'
import type { CV, Mat } from '../src/lib/tracking/cv'
import { Observations, Status, type AnchorObs } from '../src/lib/tracking/observations'
import { TrackSession, type Keyframe, type ResumeState } from '../src/lib/tracking/session'
import { driftPath, loadCv, makeTexture, MatFrame, renderVideo, type SyntheticVideo } from './helpers'

let cv: CV
let texture: Mat
const W = 480
const H = 320
const OFFSET = { x: 120, y: 120 }

beforeAll(async () => {
  cv = await loadCv()
  texture = makeTexture(cv, W + 240, H + 240)
})
afterAll(() => texture?.delete())

interface RunOptions {
  anchors: Rect[]
  refIndex?: number
  rotation?: boolean
  keyframes?: Keyframe[]
  searchRadius?: number
  resume?: ResumeState
  /** Pre-filled observations (for resume runs). */
  into?: Observations
}

function run(video: SyntheticVideo, o: RunOptions): Observations {
  const obs = o.into ?? new Observations(video.frames.length, o.anchors.length)
  const session = new TrackSession(
    cv,
    {
      width: video.width,
      height: video.height,
      anchors: o.anchors,
      refIndex: o.refIndex ?? 0,
      keyframes: o.keyframes ?? [],
      params: { searchRadius: o.searchRadius ?? 24, minScore: 0.8, rotation: o.rotation ?? false },
    },
    o.resume,
  )
  for (const i of session.templateFrames()) session.loadTemplates(i, new MatFrame(cv, video.frames[i]))
  for (let f = o.resume?.startIndex ?? 0; f < video.frames.length; f++) {
    session.process(f, new MatFrame(cv, video.frames[f])).forEach((a, i) => obs.set(f, i, a))
  }
  session.dispose()
  return obs
}

/** Where the anchor centred at `ref` in the reference frame appears in each frame. */
function truth(video: SyntheticVideo, refIndex: number, ref: Vec2): Vec2[] {
  const back = invert(video.motion[refIndex])
  return video.motion.map((M) => apply(multiply(M, back), ref))
}

function centre(r: Rect): Vec2 {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

function errors(obs: Observations, anchor: number, expected: Vec2[], frames?: number[]): number[] {
  return (frames ?? expected.map((_, i) => i)).map((f) => {
    const o: AnchorObs = obs.get(f, anchor)
    return Math.hypot(o.x - expected[f].x, o.y - expected[f].y)
  })
}

const max = (v: number[]) => Math.max(...v)

describe('TrackSession', () => {
  it('tracks translation drift to sub-pixel accuracy', () => {
    const video = renderVideo(cv, texture, W, H, OFFSET, driftPath(60))
    const box = { x: 180, y: 120, w: 64, h: 64 }
    const obs = run(video, { anchors: [box] })
    const e = errors(obs, 0, truth(video, 0, centre(box)))
    expect(max(e)).toBeLessThan(0.15)
    for (let f = 1; f < 60; f++) expect(obs.statusAt(f, 0)).toBe(Status.Ok)
    video.dispose()
  })

  it('tracks rolling drift with two anchors and recovers the rotation', () => {
    const sims = driftPath(60, { roll: 0.05, zoom: 0.01 })
    const video = renderVideo(cv, texture, W, H, OFFSET, sims)
    const boxes = [
      { x: 60, y: 60, w: 64, h: 64 },
      { x: 340, y: 190, w: 64, h: 64 },
    ]
    const obs = run(video, { anchors: boxes, rotation: true })
    boxes.forEach((b, a) => expect(max(errors(obs, a, truth(video, 0, centre(b))))).toBeLessThan(0.25))

    const traj = solveTrajectory(obs, boxes.map(centre), { model: 'rotation', pivot: { x: W / 2, y: H / 2 }, smoothing: 0 })
    traj.sims.forEach((s: Similarity, t) => {
      expect(Math.abs(s.theta - (sims[t].theta - sims[0].theta))).toBeLessThan(0.002)
    })
    video.dispose()
  })

  it('estimates roll from a single anchor patch', () => {
    const video = renderVideo(cv, texture, W, H, OFFSET, driftPath(40, { roll: 0.05 }))
    const box = { x: 170, y: 110, w: 96, h: 96 }
    const obs = run(video, { anchors: [box], rotation: true })
    const sims = driftPath(40, { roll: 0.05 })
    for (let f = 0; f < 40; f++) {
      expect(Math.abs(obs.get(f, 0).angle - (sims[f].theta - sims[0].theta))).toBeLessThan(0.01)
    }
    expect(max(errors(obs, 0, truth(video, 0, centre(box))))).toBeLessThan(0.3)
    video.dispose()
  })

  it('finds the anchor before a reference frame in the middle of the clip', () => {
    const video = renderVideo(cv, texture, W, H, OFFSET, driftPath(50, { amplitude: 40 }))
    const box = { x: 200, y: 130, w: 64, h: 64 }
    const obs = run(video, { anchors: [box], refIndex: 30 })
    expect(max(errors(obs, 0, truth(video, 30, centre(box))))).toBeLessThan(0.15)
    expect(obs.statusAt(30, 0)).toBe(Status.Key)
    video.dispose()
  })

  it('flags an occluded anchor and re-acquires it afterwards', () => {
    const video = renderVideo(cv, texture, W, H, OFFSET, driftPath(50))
    const box = { x: 180, y: 120, w: 64, h: 64 }
    const expected = truth(video, 0, centre(box))
    for (let f = 20; f < 26; f++) {
      // Something walks in front of the anchor.
      const p = expected[f]
      const m = video.frames[f]
      for (let y = Math.round(p.y - 50); y < Math.round(p.y + 50); y++) {
        m.data.fill(90, y * m.cols + Math.round(p.x - 50), y * m.cols + Math.round(p.x + 50))
      }
    }
    const obs = run(video, { anchors: [box] })
    for (let f = 20; f < 26; f++) expect([Status.Low, Status.Lost]).toContain(obs.statusAt(f, 0))
    const after = Array.from({ length: 24 }, (_, i) => 26 + i)
    for (const f of after) expect(obs.statusAt(f, 0)).toBe(Status.Ok)
    expect(max(errors(obs, 0, expected, after))).toBeLessThan(0.15)
    video.dispose()
  })

  it('snaps an imprecise correction to the true position', () => {
    const video = renderVideo(cv, texture, W, H, OFFSET, driftPath(30))
    const box = { x: 180, y: 120, w: 64, h: 64 }
    const expected = truth(video, 0, centre(box))
    const hint = { x: expected[15].x + 2.6, y: expected[15].y - 1.8 }
    const obs = run(video, { anchors: [box], keyframes: [{ anchor: 0, index: 15, ...hint }] })
    expect(obs.statusAt(15, 0)).toBe(Status.Key)
    expect(max(errors(obs, 0, expected))).toBeLessThan(0.2)
    video.dispose()
  })

  it('tracks a large anchor on a down-scaled image', () => {
    const video = renderVideo(cv, texture, W, H, OFFSET, driftPath(30, { amplitude: 15 }))
    const box = { x: 60, y: 40, w: 300, h: 220 }
    const obs = run(video, { anchors: [box], searchRadius: 30 })
    expect(max(errors(obs, 0, truth(video, 0, centre(box))))).toBeLessThan(0.3)
    video.dispose()
  })

  it('resuming mid-clip reproduces a full run', () => {
    const video = renderVideo(cv, texture, W, H, OFFSET, driftPath(40))
    const box = { x: 180, y: 120, w: 64, h: 64 }
    const full = run(video, { anchors: [box] })
    const start = 25
    const partial = new Observations(40, 1)
    for (let f = 0; f < start; f++) partial.set(f, 0, full.get(f, 0))
    const resume: ResumeState = {
      startIndex: start,
      angle: 0,
      anchors: [
        {
          template: null,
          history: [start - 2, start - 1].map((index) => ({ index, x: full.get(index, 0).x, y: full.get(index, 0).y })),
        },
      ],
    }
    run(video, { anchors: [box], resume, into: partial })
    for (let f = start; f < 40; f++) {
      expect(partial.get(f, 0).x).toBeCloseTo(full.get(f, 0).x, 6)
      expect(partial.get(f, 0).y).toBeCloseTo(full.get(f, 0).y, 6)
    }
    video.dispose()
  })
})
