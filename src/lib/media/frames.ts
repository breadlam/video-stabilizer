import { CanvasSink, type InputVideoTrack } from 'mediabunny'
import { nearestFrame } from './video'

export type FrameCanvas = HTMLCanvasElement | OffscreenCanvas

/** Frame-exact access for the preview: coalesced random access for scrubbing, and paced playback. */
export class FramePlayer {
  private readonly seekSink: CanvasSink
  private readonly playSink: CanvasSink
  private pending: number | null = null
  private busy = false
  private playToken = 0

  constructor(
    track: InputVideoTrack,
    private readonly timestamps: number[],
    private readonly onFrame: (index: number, canvas: FrameCanvas) => void,
    private readonly onError: (error: unknown) => void,
  ) {
    this.seekSink = new CanvasSink(track)
    this.playSink = new CanvasSink(track, { poolSize: 4 })
  }

  get playing(): boolean {
    return this.playToken % 2 === 1
  }

  /** Shows frame `index`. While a decode is in flight only the latest request is kept. */
  show(index: number): void {
    this.pending = index
    if (!this.busy) void this.pump()
  }

  private async pump(): Promise<void> {
    this.busy = true
    try {
      while (this.pending !== null) {
        const index = this.pending
        this.pending = null
        const wrapped = await this.seekSink.getCanvas(this.timestamps[index])
        if (wrapped && !this.playing) this.onFrame(index, wrapped.canvas)
      }
    } catch (err) {
      this.pending = null
      this.onError(err)
    } finally {
      this.busy = false
    }
  }

  /**
   * Plays from `from` in real time, dropping frames when decoding falls behind. Resolves with the
   * last shown index when playback ends or `stop()` is called.
   */
  async play(from: number, onEnd: (last: number) => void): Promise<void> {
    if (this.playing) return
    const token = ++this.playToken
    const ts = this.timestamps
    const t0 = ts[from]
    const wall0 = performance.now()
    let last = from
    try {
      for await (const wrapped of this.playSink.canvases(t0)) {
        if (token !== this.playToken) break
        const index = nearestFrame(ts, wrapped.timestamp)
        const due = wall0 + (wrapped.timestamp - t0) * 1000
        const wait = due - performance.now()
        if (wait > 4) await new Promise((r) => setTimeout(r, wait))
        else if (wait < -100 && index < ts.length - 1) continue
        if (token !== this.playToken) break
        last = index
        this.onFrame(index, wrapped.canvas)
      }
    } catch (err) {
      this.onError(err)
    } finally {
      if (token === this.playToken) this.playToken++
      onEnd(last)
    }
  }

  stop(): void {
    if (this.playing) this.playToken++
  }
}
