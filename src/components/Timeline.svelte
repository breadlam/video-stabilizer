<script lang="ts">
  import { app } from '../lib/state/app.svelte'
  import { isUsable, Status } from '../lib/tracking/observations'

  const HEIGHT = 40
  const COLORS = ['#2a303c', '#2f9e6e', '#d39b2a', '#e04848']

  let container: HTMLDivElement | undefined = $state()
  let canvas: HTMLCanvasElement | undefined = $state()
  let width = $state(0)
  let dpr = $state(1)
  let scrubbing = false

  $effect(() => {
    if (!container) return
    const ro = new ResizeObserver(() => {
      width = container!.clientWidth
      dpr = window.devicePixelRatio || 1
    })
    ro.observe(container)
    return () => ro.disconnect()
  })

  /** Per-frame class: 0 untracked, 1 all anchors usable, 2 some usable, 3 none usable. */
  const classes = $derived.by(() => {
    void app.obsVersion
    const n = app.frameCount
    const out = new Uint8Array(n)
    const obs = app.obs
    if (!obs) return out
    for (let f = 0; f < Math.min(n, app.trackedUpTo); f++) {
      let usable = 0
      let any = false
      for (let a = 0; a < obs.anchors; a++) {
        const s = obs.status[f * obs.anchors + a]
        if (s !== Status.None) any = true
        if (isUsable(s)) usable++
      }
      out[f] = !any ? 0 : usable === obs.anchors ? 1 : usable > 0 ? 2 : 3
    }
    return out
  })

  $effect(() => {
    const ctx = canvas?.getContext('2d')
    const n = app.frameCount
    if (!ctx || !canvas || !width || !n) return
    const W = Math.round(width * dpr)
    const H = Math.round(HEIGHT * dpr)
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W
      canvas.height = H
    }
    const pad = 8 * dpr
    const inner = W - 2 * pad
    const x = (f: number) => pad + ((f + 0.5) / n) * inner
    ctx.clearRect(0, 0, W, H)

    // Confidence strip: each pixel column shows the worst class among the frames it covers (frames
    // are spread evenly across the strip, so a column may cover several frames or part of one).
    const top = 12 * dpr
    const stripH = 12 * dpr
    const cols = Math.max(1, Math.round(inner))
    const worst = new Uint8Array(cols)
    const cls = classes
    for (let c = 0; c < cols; c++) {
      const f0 = Math.min(n - 1, Math.floor((c / cols) * n))
      const f1 = Math.max(f0, Math.min(n - 1, Math.ceil(((c + 1) / cols) * n) - 1))
      for (let f = f0; f <= f1; f++) if (cls[f] > worst[c]) worst[c] = cls[f]
    }
    let run = 0
    for (let c = 1; c <= cols; c++) {
      if (c === cols || worst[c] !== worst[run]) {
        ctx.fillStyle = COLORS[worst[run]]
        ctx.fillRect(pad + run, top, c - run, stripH)
        run = c
      }
    }

    // Reference frame.
    const rx = x(app.refIndex)
    ctx.fillStyle = '#5b8cff'
    ctx.beginPath()
    ctx.moveTo(rx - 5 * dpr, 2 * dpr)
    ctx.lineTo(rx + 5 * dpr, 2 * dpr)
    ctx.lineTo(rx, 10 * dpr)
    ctx.closePath()
    ctx.fill()

    // Corrections.
    const colorOf = new Map(app.anchors.map((a) => [a.id, a.color]))
    for (const c of app.corrections) {
      const cx = x(c.index)
      const cy = top + stripH + 7 * dpr
      const r = 4 * dpr
      ctx.fillStyle = colorOf.get(c.anchorId) ?? '#fff'
      ctx.beginPath()
      ctx.moveTo(cx, cy - r)
      ctx.lineTo(cx + r, cy)
      ctx.lineTo(cx, cy + r)
      ctx.lineTo(cx - r, cy)
      ctx.closePath()
      ctx.fill()
    }

    // Stale region after corrections.
    if (app.dirtyFrom !== null) {
      ctx.fillStyle = '#0e1014aa'
      const from = pad + (app.dirtyFrom / n) * inner
      ctx.fillRect(from, top, W - pad - from, stripH)
    }

    // Playhead.
    const px = x(app.frame)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(px - 1 * dpr, 4 * dpr, 2 * dpr, H - 8 * dpr)
  })

  function frameAt(e: PointerEvent): number {
    const r = canvas!.getBoundingClientRect()
    const pad = 8
    const t = (e.clientX - r.left - pad) / (r.width - 2 * pad)
    return Math.min(app.frameCount - 1, Math.max(0, Math.floor(t * app.frameCount)))
  }
</script>

<div class="timeline" bind:this={container}>
  <canvas
    bind:this={canvas}
    style:width="{width}px"
    style:height="{HEIGHT}px"
    role="slider"
    tabindex="-1"
    aria-label="Timeline"
    aria-valuemin={1}
    aria-valuemax={app.frameCount}
    aria-valuenow={app.frame + 1}
    onpointerdown={(e) => {
      scrubbing = true
      canvas!.setPointerCapture(e.pointerId)
      app.seek(frameAt(e))
    }}
    onpointermove={(e) => {
      if (scrubbing) app.seek(frameAt(e))
    }}
    onpointerup={() => (scrubbing = false)}
    onpointercancel={() => (scrubbing = false)}
  ></canvas>
</div>

<style>
  .timeline {
    flex: none;
    background: var(--panel);
    border-top: 1px solid var(--border);
    padding-top: 4px;
  }

  canvas {
    display: block;
    cursor: pointer;
    touch-action: none;
  }
</style>
