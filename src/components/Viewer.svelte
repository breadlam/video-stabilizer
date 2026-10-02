<script lang="ts">
  import { multiply, translation, type Affine, type Vec2 } from '../lib/geometry/affine'
  import type { Rect } from '../lib/geometry/crop'
  import { drawThrough, outputMatrix } from '../lib/render/warp'
  import { app, MIN_ANCHOR_SIDE, statusLabel } from '../lib/state/app.svelte'
  import { isUsable } from '../lib/tracking/observations'

  type Drag =
    | { mode: 'draw'; start: Vec2; current: Vec2 }
    | { mode: 'move' | 'resize'; id: number; start: Vec2; current: Vec2; rect: Rect }
    | { mode: 'correct'; id: number; offset: Vec2; current: Vec2 }

  const LOUPE = 152

  let container: HTMLDivElement | undefined = $state()
  let canvas: HTMLCanvasElement | undefined = $state()
  let loupe: HTMLCanvasElement | undefined = $state()
  let size = $state({ w: 0, h: 0, dpr: 1 })
  let drag = $state<Drag | null>(null)
  let pointer = $state<Vec2 | null>(null)

  /** Frame → canvas pixel mapping (frame letterboxed into the canvas). */
  const layout = $derived.by(() => {
    const info = app.info
    if (!info || !size.w || !size.h) return null
    const cw = Math.round(size.w * size.dpr)
    const ch = Math.round(size.h * size.dpr)
    const k = Math.min(cw / info.width, ch / info.height)
    const dw = info.width * k
    const dh = info.height * k
    return { k, cw, ch, dw, dh, ox: (cw - dw) / 2, oy: (ch - dh) / 2 }
  })

  const shown = $derived(app.canvasIndex)
  const onReference = $derived(shown === app.refIndex)
  const tracked = $derived(!!app.obs && shown >= 0 && shown < app.trackedUpTo)
  const stabilized = $derived(app.view === 'stabilized' && !!app.trajectory && !!app.crop)

  $effect(() => {
    if (!container) return
    const ro = new ResizeObserver(() => {
      size = { w: container!.clientWidth, h: container!.clientHeight, dpr: window.devicePixelRatio || 1 }
    })
    ro.observe(container)
    return () => ro.disconnect()
  })

  // ---- geometry helpers ------------------------------------------------------------------------

  function centre(r: Rect): Vec2 {
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
  }

  /** Result of a move/resize drag. */
  function draggedRect(d: Extract<Drag, { mode: 'move' | 'resize' }>): Rect {
    const dx = d.current.x - d.start.x
    const dy = d.current.y - d.start.y
    if (d.mode === 'move') return app.clampRect({ ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy })
    return app.clampRect({ ...d.rect, w: Math.max(MIN_ANCHOR_SIDE, d.rect.w + dx), h: Math.max(MIN_ANCHOR_SIDE, d.rect.h + dy) })
  }

  /** Anchor rect on the reference frame, including an in-progress move/resize. */
  function liveRect(id: number, rect: Rect): Rect {
    const d = drag
    if (!d || (d.mode !== 'move' && d.mode !== 'resize') || d.id !== id) return rect
    return draggedRect(d)
  }

  /** Where anchor i is drawn on the shown frame (tracked position or a drag in progress). */
  function trackedCentre(i: number): Vec2 | null {
    const d = drag
    const a = app.anchors[i]
    if (d?.mode === 'correct' && d.id === a.id) return { x: d.current.x - d.offset.x, y: d.current.y - d.offset.y }
    const correction = app.corrections.find((c) => c.anchorId === a.id && c.index === shown)
    if (correction && (!tracked || app.dirtyFrom !== null)) return correction
    if (!tracked) return null
    const o = app.obs!.get(shown, i)
    return { x: o.x, y: o.y }
  }

  function normRect(a: Vec2, b: Vec2): Rect {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
  }

  function toFrame(e: PointerEvent): Vec2 | null {
    const L = layout
    if (!L || !canvas) return null
    const r = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - r.left) * size.dpr - L.ox) / L.k,
      y: ((e.clientY - r.top) * size.dpr - L.oy) / L.k,
    }
  }

  type Hit = { id: number; part: 'body' | 'handle' }
  function hitTest(p: Vec2): Hit | null {
    const L = layout
    if (!L) return null
    const tol = (10 * size.dpr) / L.k
    for (let i = app.anchors.length - 1; i >= 0; i--) {
      const a = app.anchors[i]
      if (onReference) {
        const r = a.rect
        if (a.id === app.selected && Math.abs(p.x - (r.x + r.w)) <= tol && Math.abs(p.y - (r.y + r.h)) <= tol) {
          return { id: a.id, part: 'handle' }
        }
        if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return { id: a.id, part: 'body' }
      } else {
        const c = trackedCentre(i)
        if (c && Math.abs(p.x - c.x) <= a.rect.w / 2 && Math.abs(p.y - c.y) <= a.rect.h / 2) return { id: a.id, part: 'body' }
      }
    }
    return null
  }

  const hover = $derived(pointer && !stabilized ? hitTest(pointer) : null)
  const cursor = $derived.by(() => {
    if (stabilized || !app.canvas) return 'default'
    if (drag) return drag.mode === 'correct' ? 'grabbing' : drag.mode === 'resize' ? 'nwse-resize' : drag.mode === 'move' ? 'move' : 'crosshair'
    if (onReference) return hover?.part === 'handle' ? 'nwse-resize' : hover ? 'move' : 'crosshair'
    return hover ? 'grab' : 'default'
  })

  // ---- pointer --------------------------------------------------------------------------------

  function onDown(e: PointerEvent) {
    if (e.button !== 0 || stabilized || !app.canvas) return
    const p = toFrame(e)
    if (!p) return
    app.stop()
    const hit = hitTest(p)
    if (onReference) {
      if (hit) {
        const a = app.anchors.find((x) => x.id === hit.id)!
        app.selected = a.id
        drag = { mode: hit.part === 'handle' ? 'resize' : 'move', id: a.id, start: p, current: p, rect: { ...a.rect } }
      } else {
        app.selected = null
        drag = { mode: 'draw', start: p, current: p }
      }
    } else if (hit) {
      const i = app.anchors.findIndex((x) => x.id === hit.id)
      const c = trackedCentre(i)!
      app.selected = hit.id
      drag = { mode: 'correct', id: hit.id, offset: { x: p.x - c.x, y: p.y - c.y }, current: p }
    }
    if (drag) canvas!.setPointerCapture(e.pointerId)
  }

  function onMove(e: PointerEvent) {
    const p = toFrame(e)
    pointer = p
    if (drag && p) drag = { ...drag, current: p }
  }

  function onUp() {
    const d = drag
    drag = null
    if (!d) return
    if (d.mode === 'draw') {
      const r = normRect(d.start, d.current)
      if (r.w >= MIN_ANCHOR_SIDE / 2 && r.h >= MIN_ANCHOR_SIDE / 2) app.addAnchor(r)
    } else if (d.mode === 'correct') {
      const c = { x: d.current.x - d.offset.x, y: d.current.y - d.offset.y }
      const i = app.anchors.findIndex((x) => x.id === d.id)
      const before = trackedCentre(i)
      if (!before || Math.hypot(before.x - c.x, before.y - c.y) > 0.25) app.setCorrection(d.id, shown, c)
    } else if (d.current.x !== d.start.x || d.current.y !== d.start.y) {
      app.updateAnchor(d.id, draggedRect(d))
    }
  }

  // ---- drawing --------------------------------------------------------------------------------

  let history: OffscreenCanvas | null = null
  let historyIndex = -2

  $effect(() => {
    const L = layout
    const ctx = canvas?.getContext('2d')
    if (!L || !ctx || !canvas) return
    // Dependencies that are only read inside helpers:
    void app.obsVersion
    void drag
    void app.selected
    void app.corrections
    if (canvas.width !== L.cw || canvas.height !== L.ch) {
      canvas.width = L.cw
      canvas.height = L.ch
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#08090c'
    ctx.fillRect(0, 0, L.cw, L.ch)
    const src = app.canvas
    if (!src) return
    if (stabilized) drawStabilized(ctx, src, L)
    else drawOriginal(ctx, src, L)
  })

  function drawOriginal(ctx: CanvasRenderingContext2D, src: CanvasImageSource, L: NonNullable<typeof layout>) {
    const view: Affine = { a: L.k, b: 0, c: 0, d: L.k, e: L.ox, f: L.oy }
    drawThrough(ctx, src, view, false)
    const px = size.dpr
    const toC = (p: Vec2) => ({ x: L.ox + p.x * L.k, y: L.oy + p.y * L.k })
    ctx.lineJoin = 'round'

    if (onReference) {
      app.anchors.forEach((a, i) => {
        const r = liveRect(a.id, a.rect)
        const p = toC(r)
        const selected = a.id === app.selected
        ctx.strokeStyle = a.color
        ctx.lineWidth = (selected ? 2.5 : 1.75) * px
        ctx.strokeRect(p.x, p.y, r.w * L.k, r.h * L.k)
        crosshair(ctx, toC(centre(r)), 6 * px, a.color, px)
        tag(ctx, p, String(i + 1), a.color, px)
        if (selected) {
          const h = 7 * px
          ctx.fillStyle = a.color
          ctx.fillRect(p.x + r.w * L.k - h / 2, p.y + r.h * L.k - h / 2, h, h)
        }
      })
      if (drag?.mode === 'draw') {
        const r = normRect(drag.start, drag.current)
        const p = toC(r)
        ctx.setLineDash([6 * px, 4 * px])
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 1.5 * px
        ctx.strokeRect(p.x, p.y, r.w * L.k, r.h * L.k)
        ctx.setLineDash([])
      }
      return
    }

    const rotation = app.settings.model === 'rotation'
    app.anchors.forEach((a, i) => {
      const ref = centre(a.rect)
      const c = trackedCentre(i)
      if (!c) {
        // Not tracked yet: show where the anchor was on the reference frame.
        const p = toC(a.rect)
        ctx.setLineDash([4 * px, 4 * px])
        ctx.strokeStyle = a.color + '99'
        ctx.lineWidth = 1.25 * px
        ctx.strokeRect(p.x, p.y, a.rect.w * L.k, a.rect.h * L.k)
        ctx.setLineDash([])
        return
      }
      const o = tracked ? app.obs!.get(shown, i) : null
      const correcting = drag?.mode === 'correct' && drag.id === a.id
      const corrected = app.corrections.some((x) => x.anchorId === a.id && x.index === shown)
      const good = correcting || corrected || (o ? isUsable(o.status) : false)
      const color = good ? a.color : '#ff5d5d'

      // Drift vector from the pinned position to where the anchor is now.
      const pr = toC(ref)
      const pc = toC(c)
      crosshair(ctx, pr, 5 * px, '#ffffffaa', px)
      ctx.strokeStyle = '#ffffff88'
      ctx.lineWidth = 1 * px
      ctx.beginPath()
      ctx.moveTo(pr.x, pr.y)
      ctx.lineTo(pc.x, pc.y)
      ctx.stroke()

      ctx.save()
      ctx.translate(pc.x, pc.y)
      if (rotation && o && !correcting) ctx.rotate(o.angle)
      ctx.strokeStyle = color
      ctx.lineWidth = (a.id === app.selected ? 2.5 : 1.75) * px
      if (!good) ctx.setLineDash([5 * px, 4 * px])
      ctx.strokeRect((-a.rect.w / 2) * L.k, (-a.rect.h / 2) * L.k, a.rect.w * L.k, a.rect.h * L.k)
      ctx.restore()
      crosshair(ctx, pc, 6 * px, color, px)
      const label = corrected || correcting ? `${i + 1} ◆` : o ? `${i + 1} · ${statusLabel(o.status)}` : `${i + 1}`
      tag(ctx, { x: pc.x - (a.rect.w / 2) * L.k, y: pc.y - (a.rect.h / 2) * L.k }, label, color, px)
    })
  }

  function drawStabilized(ctx: CanvasRenderingContext2D, src: CanvasImageSource, L: NonNullable<typeof layout>) {
    const traj = app.trajectory!
    const crop = app.crop!
    const w = Math.round(L.dw)
    const h = Math.round(L.dh)
    if (!history || history.width !== w || history.height !== h) {
      history = new OffscreenCanvas(w, h)
      historyIndex = -2
    }
    const hctx = history.getContext('2d')!
    const sequential = shown === historyIndex + 1 || shown === historyIndex
    const keep = app.settings.fill === 'history' && sequential
    drawThrough(hctx, src, outputMatrix(traj.toRef[shown], crop.rect, w, h), !keep)
    historyIndex = shown
    ctx.drawImage(history, Math.round(L.ox), Math.round(L.oy))

    // Pinned anchor positions: tracked anchors should sit exactly on these marks.
    const px = size.dpr
    const toOut: Affine = multiply(
      translation(Math.round(L.ox), Math.round(L.oy)),
      multiply({ a: w / crop.rect.w, b: 0, c: 0, d: h / crop.rect.h, e: 0, f: 0 }, translation(-crop.rect.x, -crop.rect.y)),
    )
    for (const a of app.anchors) {
      const c = centre(a.rect)
      crosshair(ctx, { x: toOut.a * c.x + toOut.e, y: toOut.d * c.y + toOut.f }, 7 * px, a.color + 'cc', px)
    }
  }

  function crosshair(ctx: CanvasRenderingContext2D, p: Vec2, r: number, color: string, px: number) {
    ctx.strokeStyle = color
    ctx.lineWidth = 1.25 * px
    ctx.beginPath()
    ctx.moveTo(p.x - r, p.y)
    ctx.lineTo(p.x + r, p.y)
    ctx.moveTo(p.x, p.y - r)
    ctx.lineTo(p.x, p.y + r)
    ctx.stroke()
  }

  function tag(ctx: CanvasRenderingContext2D, p: Vec2, text: string, color: string, px: number) {
    ctx.font = `600 ${11 * px}px system-ui, sans-serif`
    const w = ctx.measureText(text).width + 8 * px
    const h = 16 * px
    ctx.fillStyle = color
    ctx.fillRect(p.x, p.y - h, w, h)
    ctx.fillStyle = '#0e1014'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, p.x + 4 * px, p.y - h / 2 + 0.5 * px)
  }

  // ---- loupe ----------------------------------------------------------------------------------

  const showLoupe = $derived(!!pointer && !stabilized && !!app.canvas && (onReference || !!drag))

  $effect(() => {
    const L = layout
    const p = pointer
    const src = app.canvas
    void drag
    if (!showLoupe || !loupe || !L || !p || !src) return
    const ctx = loupe.getContext('2d')!
    const dpr = size.dpr
    const pxSize = LOUPE * dpr
    if (loupe.width !== pxSize) {
      loupe.width = pxSize
      loupe.height = pxSize
    }
    // Four times the view's magnification, in canvas pixels per frame pixel.
    const mag = Math.max(1.5 * dpr, 4 * L.k)
    const m: Affine = { a: mag, b: 0, c: 0, d: mag, e: pxSize / 2 - p.x * mag, f: pxSize / 2 - p.y * mag }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, pxSize, pxSize)
    ctx.imageSmoothingEnabled = false
    ctx.setTransform(m.a, 0, 0, m.d, m.e, m.f)
    ctx.drawImage(src, 0, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const toL = (q: Vec2) => ({ x: m.a * q.x + m.e, y: m.d * q.y + m.f })
    ctx.lineWidth = 1.5 * dpr
    if (onReference) {
      for (const a of app.anchors) {
        const r = liveRect(a.id, a.rect)
        const q = toL(r)
        ctx.strokeStyle = a.color
        ctx.strokeRect(q.x, q.y, r.w * mag, r.h * mag)
      }
      if (drag?.mode === 'draw') {
        const r = normRect(drag.start, drag.current)
        const q = toL(r)
        ctx.strokeStyle = '#fff'
        ctx.strokeRect(q.x, q.y, r.w * mag, r.h * mag)
      }
    }
    crosshair(ctx, { x: pxSize / 2, y: pxSize / 2 }, 9 * dpr, '#ffffffdd', dpr)
  })

  const hint = $derived.by(() => {
    if (!app.canvas) return 'Decoding…'
    if (stabilized) return shown >= app.trackedUpTo ? 'Not tracked yet: showing the last known correction.' : null
    if (onReference) {
      return app.anchors.length
        ? 'Reference frame · drag to add anchors · drag a box to move it, its corner to resize'
        : 'Reference frame · drag a box around something that never moves'
    }
    if (!app.anchors.length) return `Anchors are placed on the reference frame (#${app.refIndex + 1}).`
    if (tracked || app.corrections.some((c) => c.index === shown)) return 'Drag an anchor to correct its position on this frame.'
    return null
  })
</script>

<div class="viewer" bind:this={container}>
  <canvas
    bind:this={canvas}
    style:width="{size.w}px"
    style:height="{size.h}px"
    style:cursor
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    onpointercancel={() => (drag = null)}
    onpointerleave={() => {
      if (!drag) pointer = null
    }}
  ></canvas>
  <canvas
    class="loupe"
    class:hidden={!showLoupe}
    bind:this={loupe}
    style:width="{LOUPE}px"
    style:height="{LOUPE}px"
    aria-hidden="true"
  ></canvas>
  {#if hint}
    <div class="hint">{hint}</div>
  {/if}
  {#if app.view === 'stabilized' && app.crop}
    <div class="badge mono">
      Stabilized · zoom ×{app.crop.zoom.toFixed(2)}
    </div>
  {/if}
</div>

<style>
  .viewer {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    user-select: none;
    touch-action: none;
  }

  canvas {
    display: block;
  }

  .loupe {
    position: absolute;
    top: 12px;
    right: 12px;
    border-radius: 10px;
    border: 1px solid #ffffff40;
    box-shadow: 0 6px 24px #0008;
    pointer-events: none;
  }

  .hidden {
    display: none;
  }

  .hint,
  .badge {
    position: absolute;
    left: 12px;
    padding: 4px 10px;
    border-radius: 999px;
    background: #0e1014cc;
    border: 1px solid var(--border);
    font-size: 12px;
    color: var(--muted);
    pointer-events: none;
    max-width: calc(100% - 24px);
  }

  .hint {
    bottom: 12px;
  }

  .badge {
    top: 12px;
    color: var(--text);
  }
</style>
