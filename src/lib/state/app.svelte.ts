import type { Vec2 } from '../geometry/affine'
import { autoCrop, cropForZoom, type CropResult, type Rect } from '../geometry/crop'
import { solveTrajectory, type Trajectory } from '../geometry/trajectory'
import type { FromExporter, ToExporter } from '../media/exportProtocol'
import { FramePlayer, type FrameCanvas } from '../media/frames'
import { openVideo, type OpenedVideo } from '../media/video'
import { evenSize, packMatrices } from '../render/warp'
import { isUsable, Observations, Status } from '../tracking/observations'
import type { FromTracker, ToTracker } from '../tracking/protocol'
import type { ResumeState, TemplateSource } from '../tracking/session'
import { parseProject, serializeProject, type Anchor, type Correction, type Settings } from './project'

export type { Anchor, Correction, Settings }

const COLORS = ['#ffd23f', '#3fd8ff', '#ff5ca8', '#7dff6b', '#b38cff', '#ff8a3d']
/** Smallest anchor box side, in frame pixels. */
export const MIN_ANCHOR_SIDE = 16

export interface TrackingRun {
  phase: 'loading' | 'running'
  startIndex: number
  /** Frames processed so far in this run. */
  processed: number
  total: number
}

export interface ExportRun {
  phase: 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  message?: string
  url?: string
  fileName?: string
  size?: number
  savedToDisk?: boolean
  warnings?: string[]
}

function defaultSettings(width = 1920, height = 1080): Settings {
  return {
    model: 'translation',
    searchRadius: Math.round(Math.min(160, Math.max(16, 0.04 * Math.max(width, height)))),
    minScore: 0.8,
    smoothing: 0,
    zoomMode: 'auto',
    zoom: 1,
    fill: 'black',
    quality: 'high',
  }
}

class AppState {
  video = $state.raw<OpenedVideo | null>(null)
  loading = $state<string | null>(null)
  error = $state<string | null>(null)
  notice = $state<string | null>(null)

  /** Current frame index and its decoded canvas. */
  frame = $state(0)
  canvas = $state.raw<FrameCanvas | null>(null)
  canvasIndex = $state(-1)
  playing = $state(false)
  view = $state<'original' | 'stabilized'>('original')

  refIndex = $state(0)
  anchors = $state<Anchor[]>([])
  corrections = $state<Correction[]>([])
  selected = $state<number | null>(null)
  settings = $state<Settings>(defaultSettings())

  obs = $state.raw<Observations | null>(null)
  /** Bumped whenever `obs` is mutated in place. */
  obsVersion = $state(0)
  /** Frames [0, trackedUpTo) have results. */
  trackedUpTo = $state(0)
  /** Earliest frame affected by corrections made since the last tracking run. */
  dirtyFrom = $state<number | null>(null)
  tracking = $state<TrackingRun | null>(null)
  lastRun = $state<{ seconds: number; frames: number } | null>(null)

  exporting = $state<ExportRun | null>(null)

  private player: FramePlayer | null = null
  private tracker: Worker | null = null
  private exporter: Worker | null = null
  private nextAnchorId = 1

  // ---- derived -------------------------------------------------------------------------------

  get info() {
    return this.video?.info ?? null
  }

  get frameCount(): number {
    return this.video?.info.timestamps.length ?? 0
  }

  get refPoints(): Vec2[] {
    return this.anchors.map((a) => ({ x: a.rect.x + a.rect.w / 2, y: a.rect.y + a.rect.h / 2 }))
  }

  readonly trajectory: Trajectory | null = $derived.by(() => {
    void this.obsVersion
    const info = this.info
    const obs = this.obs
    if (!info || !obs || this.trackedUpTo === 0 || obs.anchors !== this.anchors.length) return null
    return solveTrajectory(obs, this.refPoints, {
      model: this.settings.model,
      pivot: { x: info.width / 2, y: info.height / 2 },
      smoothing: this.settings.smoothing,
      trackedFrames: this.trackedUpTo,
    })
  })

  /** Largest crop without uncovered edges. */
  readonly autoCropResult: CropResult | null = $derived.by(() => {
    const info = this.info
    const t = this.trajectory
    if (!info || !t) return null
    return autoCrop(t.toRef.slice(0, this.trackedUpTo), info.width, info.height)
  })

  readonly crop: CropResult | null = $derived.by(() => {
    const info = this.info
    const auto = this.autoCropResult
    if (!info || !auto) return null
    if (this.settings.zoomMode === 'auto') return auto
    return cropForZoom(auto, Math.min(this.settings.zoom, auto.zoom), info.width, info.height)
  })

  readonly outputSize = $derived(this.info ? evenSize(this.info.width, this.info.height) : null)

  /** Frames where at least one anchor was not usable, among tracked frames. */
  readonly problemFrames: number = $derived.by(() => {
    void this.obsVersion
    const obs = this.obs
    if (!obs) return 0
    let count = 0
    for (let f = 0; f < this.trackedUpTo; f++) {
      for (let a = 0; a < obs.anchors; a++) {
        if (!isUsable(obs.status[f * obs.anchors + a])) {
          count++
          break
        }
      }
    }
    return count
  })

  get trackingComplete(): boolean {
    return !!this.obs && this.trackedUpTo >= this.frameCount && this.dirtyFrom === null
  }

  // ---- video ----------------------------------------------------------------------------------

  async load(file: File): Promise<void> {
    this.stop()
    this.loading = `Opening ${file.name}…`
    this.error = null
    try {
      const video = await openVideo(file)
      this.closeVideo()
      this.video = video
      this.settings = { ...defaultSettings(video.info.width, video.info.height), quality: this.settings.quality }
      this.player = new FramePlayer(
        video.track,
        video.info.timestamps,
        (index, canvas) => {
          this.canvas = canvas
          this.canvasIndex = index
          if (this.playing) this.frame = index
        },
        (err) => {
          const codec = video.info.codec?.toUpperCase() ?? 'this'
          this.error =
            `This browser failed to decode ${codec} video (${err instanceof Error ? err.message : String(err)}). ` +
            'Try another browser, or convert the file to H.264 MP4.'
        },
      )
      this.seek(0)
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
    } finally {
      this.loading = null
    }
  }

  closeVideo(): void {
    this.stop()
    this.cancelTracking()
    this.clearExport()
    this.video?.input.dispose()
    this.video = null
    this.player = null
    this.canvas = null
    this.canvasIndex = -1
    this.frame = 0
    this.refIndex = 0
    this.anchors = []
    this.corrections = []
    this.selected = null
    this.view = 'original'
    this.resetTracking()
  }

  seek(index: number): void {
    const n = this.frameCount
    if (!n) return
    this.stop()
    this.frame = Math.min(n - 1, Math.max(0, Math.round(index)))
    this.player?.show(this.frame)
  }

  step(delta: number): void {
    this.seek(this.frame + delta)
  }

  play(): void {
    if (!this.player || this.playing) return
    const from = this.frame >= this.frameCount - 1 ? 0 : this.frame
    this.playing = true
    void this.player.play(from, (last) => {
      this.playing = false
      this.frame = last
    })
  }

  stop(): void {
    this.player?.stop()
    this.playing = false
  }

  togglePlay(): void {
    if (this.playing) this.stop()
    else this.play()
  }

  // ---- anchors & corrections ------------------------------------------------------------------

  setReference(index: number): void {
    this.refIndex = index
    this.anchors = []
    this.corrections = []
    this.selected = null
    this.resetTracking()
  }

  addAnchor(rect: Rect): void {
    const id = this.nextAnchorId++
    const used = new Set(this.anchors.map((a) => a.color))
    const color = COLORS.find((c) => !used.has(c)) ?? COLORS[id % COLORS.length]
    this.anchors = [...this.anchors, { id, color, rect: this.clampRect(rect) }]
    this.selected = id
    this.resetTracking()
  }

  updateAnchor(id: number, rect: Rect): void {
    this.anchors = this.anchors.map((a) => (a.id === id ? { ...a, rect: this.clampRect(rect) } : a))
    this.resetTracking()
  }

  removeAnchor(id: number): void {
    this.anchors = this.anchors.filter((a) => a.id !== id)
    this.corrections = this.corrections.filter((c) => c.anchorId !== id)
    if (this.selected === id) this.selected = null
    this.resetTracking()
  }

  /** Integer box fully inside the frame. */
  clampRect(r: Rect): Rect {
    const info = this.info!
    const w = Math.round(Math.min(info.width, Math.max(MIN_ANCHOR_SIDE, r.w)))
    const h = Math.round(Math.min(info.height, Math.max(MIN_ANCHOR_SIDE, r.h)))
    const x = Math.round(Math.min(info.width - w, Math.max(0, r.x)))
    const y = Math.round(Math.min(info.height - h, Math.max(0, r.y)))
    return { x, y, w, h }
  }

  setCorrection(anchorId: number, index: number, p: Vec2): void {
    if (index === this.refIndex) return
    const rest = this.corrections.filter((c) => !(c.anchorId === anchorId && c.index === index))
    this.corrections = [...rest, { anchorId, index, x: p.x, y: p.y }].sort((a, b) => a.index - b.index)
    this.markDirty(index)
  }

  removeCorrection(anchorId: number, index: number): void {
    const before = this.corrections.length
    this.corrections = this.corrections.filter((c) => !(c.anchorId === anchorId && c.index === index))
    if (this.corrections.length !== before) this.markDirty(index)
  }

  private markDirty(index: number): void {
    if (!this.obs) return
    this.dirtyFrom = Math.min(this.dirtyFrom ?? index, index)
  }

  /** Settings that change what the tracker does invalidate its results. */
  setTrackingSetting<K extends 'model' | 'searchRadius' | 'minScore'>(key: K, value: Settings[K]): void {
    if (this.settings[key] === value) return
    this.settings[key] = value
    this.resetTracking()
  }

  private resetTracking(): void {
    this.cancelTracking()
    this.obs = null
    this.trackedUpTo = 0
    this.dirtyFrom = null
    this.lastRun = null
    this.obsVersion++
  }

  /** Next frame after `from` (wrapping) where some anchor is not usable. */
  nextProblem(from: number): number | null {
    const obs = this.obs
    if (!obs) return null
    const n = this.trackedUpTo
    for (let k = 1; k <= n; k++) {
      const f = (from + k) % n
      for (let a = 0; a < obs.anchors; a++) {
        if (!isUsable(obs.status[f * obs.anchors + a])) return f
      }
    }
    return null
  }

  // ---- tracking -------------------------------------------------------------------------------

  /** Where the next tracking run would start: 0, the end of a cancelled run, or the earliest correction. */
  get resumeIndex(): number {
    if (!this.obs) return 0
    return Math.min(this.dirtyFrom ?? this.trackedUpTo, this.trackedUpTo)
  }

  startTracking(full = false): void {
    const video = this.video
    if (!video || !this.anchors.length || this.tracking) return
    const { info } = video
    const n = info.timestamps.length
    let start = full ? 0 : this.resumeIndex
    if (start >= n) start = 0
    let resume: ResumeState | undefined
    if (start > 0 && this.obs) {
      resume = this.buildResume(this.obs, start)
    } else {
      start = 0
      this.obs = new Observations(n, this.anchors.length)
    }
    this.obs!.clearFrom(start)
    this.trackedUpTo = start
    this.dirtyFrom = null
    this.obsVersion++

    const indexOf = new Map(this.anchors.map((a, i) => [a.id, i]))
    const job = {
      file: video.file,
      timestamps: info.timestamps,
      config: {
        width: info.width,
        height: info.height,
        anchors: this.anchors.map((a) => ({ ...a.rect })),
        refIndex: this.refIndex,
        keyframes: this.corrections.map((c) => ({ anchor: indexOf.get(c.anchorId)!, index: c.index, x: c.x, y: c.y })),
        params: {
          searchRadius: this.settings.searchRadius,
          minScore: this.settings.minScore,
          rotation: this.settings.model === 'rotation',
        },
      },
      resume,
    }
    this.tracking = { phase: 'loading', startIndex: start, processed: 0, total: n - start }
    this.tracker ??= this.createTracker()
    this.tracker.postMessage({ type: 'track', job } satisfies ToTracker)
  }

  cancelTracking(): void {
    if (!this.tracking) return
    this.tracker?.postMessage({ type: 'cancel' } satisfies ToTracker)
  }

  private createTracker(): Worker {
    const worker = new Worker(new URL('../tracking/tracker.worker.ts', import.meta.url), { type: 'module' })
    const obsAtStart = () => this.obs
    worker.onmessage = (e: MessageEvent<FromTracker>) => {
      const msg = e.data
      const run = this.tracking
      if (!run) return
      switch (msg.type) {
        case 'loading':
          break
        case 'started':
          this.tracking = { ...run, phase: 'running' }
          break
        case 'batch': {
          const obs = obsAtStart()
          if (!obs) return
          obs.writeBatch(msg.batch)
          this.trackedUpTo = msg.batch.start + msg.batch.count
          this.tracking = { ...run, phase: 'running', processed: this.trackedUpTo - run.startIndex }
          this.obsVersion++
          break
        }
        case 'done':
          this.tracking = null
          this.lastRun = { seconds: msg.seconds, frames: msg.processed }
          break
        case 'error':
          this.tracking = null
          this.error = `Tracking failed: ${msg.message}`
          break
      }
    }
    worker.onerror = (e) => {
      this.tracking = null
      this.error = `Tracking worker failed: ${e.message || 'unknown error'}`
      this.tracker?.terminate()
      this.tracker = null
    }
    return worker
  }

  private buildResume(obs: Observations, start: number): ResumeState {
    const angle = this.settings.model === 'rotation' ? (this.trajectory?.sims[start - 1]?.theta ?? 0) : 0
    return {
      startIndex: start,
      angle,
      anchors: this.anchors.map((anchor, i) => {
        let eventIndex = this.refIndex < start ? this.refIndex : -1
        let template: TemplateSource | null = null
        for (const c of this.corrections) {
          if (c.anchorId === anchor.id && c.index < start && c.index > eventIndex) {
            eventIndex = c.index
            const o = obs.get(c.index, i)
            template = { index: c.index, x: o.x, y: o.y, angle: o.angle }
          }
        }
        const history: ResumeState['anchors'][number]['history'] = []
        for (let f = start - 1; f >= Math.max(0, start - 8) && history.length < 2; f--) {
          const o = obs.get(f, i)
          if (isUsable(o.status)) history.unshift({ index: f, x: o.x, y: o.y })
        }
        return { template, history }
      }),
    }
  }

  // ---- export ---------------------------------------------------------------------------------

  async startExport(): Promise<void> {
    const video = this.video
    const traj = this.trajectory
    const crop = this.crop
    const size = this.outputSize
    if (!video || !traj || !crop || !size || this.exporting?.phase === 'running') return
    this.stop()
    const base = video.info.name.replace(/\.[^.]+$/, '')
    const fileName = `${base}-stabilized.mp4`

    let fileHandle: FileSystemFileHandle | undefined
    const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> })
      .showSaveFilePicker
    if (picker) {
      try {
        fileHandle = await picker({
          suggestedName: fileName,
          types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
        })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        fileHandle = undefined
      }
    }

    this.clearExport()
    this.exporting = { phase: 'running', progress: 0, fileName }
    const worker = new Worker(new URL('../media/export.worker.ts', import.meta.url), { type: 'module' })
    this.exporter = worker
    worker.onmessage = (e: MessageEvent<FromExporter>) => {
      const msg = e.data
      const run = this.exporting
      if (!run) return
      switch (msg.type) {
        case 'progress':
          this.exporting = { ...run, progress: msg.progress }
          return
        case 'done': {
          const blob = msg.buffer ? new Blob([msg.buffer], { type: msg.mimeType }) : null
          this.exporting = {
            ...run,
            phase: 'done',
            progress: 1,
            url: blob ? URL.createObjectURL(blob) : undefined,
            size: blob?.size,
            savedToDisk: !blob,
            warnings: msg.warnings,
            message: `Encoded as ${msg.codec.toUpperCase()}.`,
          }
          break
        }
        case 'cancelled':
          this.exporting = { ...run, phase: 'cancelled' }
          break
        case 'error':
          this.exporting = { ...run, phase: 'error', message: msg.message }
          break
      }
      worker.terminate()
      if (this.exporter === worker) this.exporter = null
    }
    worker.onerror = (e) => {
      this.exporting = { phase: 'error', progress: 0, message: e.message || 'Export worker failed.' }
      worker.terminate()
    }
    worker.postMessage({
      type: 'export',
      job: {
        file: video.file,
        timestamps: video.info.timestamps,
        matrices: packMatrices(traj.toRef, crop.rect, size.width, size.height),
        outWidth: size.width,
        outHeight: size.height,
        fill: this.settings.fill,
        quality: this.settings.quality,
        fileHandle,
      },
    } satisfies ToExporter)
  }

  cancelExport(): void {
    this.exporter?.postMessage({ type: 'cancel' } satisfies ToExporter)
  }

  clearExport(): void {
    if (this.exporting?.url) URL.revokeObjectURL(this.exporting.url)
    this.exporter?.terminate()
    this.exporter = null
    this.exporting = null
  }

  // ---- project files --------------------------------------------------------------------------

  projectBlob(): Blob | null {
    const info = this.info
    if (!info) return null
    const text = serializeProject(info, {
      refIndex: this.refIndex,
      anchors: this.anchors,
      corrections: this.corrections,
      settings: this.settings,
      obs: this.obs,
      trackedUpTo: this.trackedUpTo,
    })
    return new Blob([text], { type: 'application/json' })
  }

  async loadProject(file: File): Promise<void> {
    const info = this.info
    if (!info) return
    try {
      const p = parseProject(await file.text(), info)
      this.cancelTracking()
      this.tracking = null
      this.refIndex = p.refIndex
      this.anchors = p.anchors
      this.corrections = p.corrections
      this.settings = { ...defaultSettings(info.width, info.height), ...p.settings }
      this.obs = p.obs
      this.trackedUpTo = p.trackedUpTo
      this.dirtyFrom = null
      this.selected = null
      this.nextAnchorId = Math.max(0, ...p.anchors.map((a) => a.id)) + 1
      this.obsVersion++
      this.seek(p.refIndex)
      this.notice = `Loaded project ${file.name}.`
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
    }
  }
}

export const app = new AppState()

export function statusLabel(status: number): string {
  switch (status) {
    case Status.Ok:
      return 'tracked'
    case Status.Key:
      return 'pinned'
    case Status.Low:
      return 'low confidence'
    case Status.Lost:
      return 'lost'
    default:
      return 'not tracked'
  }
}
