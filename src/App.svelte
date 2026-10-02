<script lang="ts">
  import AnchorsPanel from './components/AnchorsPanel.svelte'
  import DropZone from './components/DropZone.svelte'
  import ExportPanel from './components/ExportPanel.svelte'
  import FramingPanel from './components/FramingPanel.svelte'
  import Timeline from './components/Timeline.svelte'
  import TrackPanel from './components/TrackPanel.svelte'
  import Transport from './components/Transport.svelte'
  import Viewer from './components/Viewer.svelte'
  import { app } from './lib/state/app.svelte'

  let fileInput: HTMLInputElement | undefined = $state()
  let draggingFile = $state(false)

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null
    if (target?.closest('input, select, textarea, [contenteditable]')) return
    if (!app.video || e.metaKey || e.ctrlKey || e.altKey) return
    const big = e.shiftKey ? 10 : 1
    switch (e.key) {
      case ' ':
        app.togglePlay()
        break
      case 'ArrowLeft':
        app.step(-big)
        break
      case 'ArrowRight':
        app.step(big)
        break
      case 'Home':
        app.seek(0)
        break
      case 'End':
        app.seek(app.frameCount - 1)
        break
      case 'v':
        if (app.trajectory) app.view = app.view === 'original' ? 'stabilized' : 'original'
        break
      case 'Delete':
      case 'Backspace':
        if (app.selected === null) return
        if (app.frame === app.refIndex) app.removeAnchor(app.selected)
        else app.removeCorrection(app.selected, app.frame)
        break
      default:
        return
    }
    e.preventDefault()
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    draggingFile = false
    const file = e.dataTransfer?.files[0]
    if (file) void app.load(file)
  }

  function onPick(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (file) void app.load(file)
    input.value = ''
  }
</script>

<svelte:window onkeydown={onKey} />

<div
  class="shell"
  role="application"
  ondragover={(e) => {
    e.preventDefault()
    draggingFile = true
  }}
  ondragleave={(e) => {
    if (e.relatedTarget === null) draggingFile = false
  }}
  ondrop={onDrop}
>
  <header>
    <div class="brand">
      <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
        <rect x="5" y="5" width="22" height="22" rx="3" fill="none" stroke="var(--accent)" stroke-width="2.5" />
        <path d="M16 9v14M9 16h14" stroke="#ffd23f" stroke-width="2.5" stroke-linecap="round" />
      </svg>
      <span>Anchor Stabilizer</span>
    </div>
    {#if app.info}
      <div class="file mono" title={app.info.name}>
        {app.info.name}
        <span class="muted">· {app.info.width}×{app.info.height} · {app.info.fps.toFixed(2)} fps · {app.frameCount} frames</span>
      </div>
      <button onclick={() => fileInput?.click()}>Open another video…</button>
    {/if}
    <input bind:this={fileInput} type="file" accept="video/*,.mp4,.mov,.m4v,.webm,.mkv" class="sr-only" onchange={onPick} />
  </header>

  {#if app.error}
    <div class="banner error" role="alert">
      <span>{app.error}</span>
      <button class="ghost" onclick={() => (app.error = null)} aria-label="Dismiss">✕</button>
    </div>
  {/if}
  {#if app.notice}
    <div class="banner notice" role="status">
      <span>{app.notice}</span>
      <button class="ghost" onclick={() => (app.notice = null)} aria-label="Dismiss">✕</button>
    </div>
  {/if}

  {#if !app.video}
    <DropZone onpick={() => fileInput?.click()} loading={app.loading} active={draggingFile} />
  {:else}
    <main>
      <section class="stage">
        <Viewer />
        <Timeline />
        <Transport />
      </section>
      <aside>
        <AnchorsPanel />
        <TrackPanel />
        <FramingPanel />
        <ExportPanel />
        <footer class="muted">
          <kbd>Space</kbd> play · <kbd>←</kbd><kbd>→</kbd> frame · <kbd>Shift</kbd> ×10 · <kbd>V</kbd> view ·
          <kbd>Del</kbd> remove
        </footer>
      </aside>
    </main>
    {#if draggingFile}
      <div class="drop-overlay">Drop to open this video</div>
    {/if}
  {/if}
</div>

<style>
  .shell {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    min-width: 0;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
    letter-spacing: 0.01em;
    white-space: nowrap;
  }

  .file {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 16px;
    font-size: 13px;
  }

  .banner.error {
    background: color-mix(in srgb, var(--bad) 18%, var(--panel));
    border-bottom: 1px solid color-mix(in srgb, var(--bad) 40%, transparent);
  }

  .banner.notice {
    background: color-mix(in srgb, var(--accent) 14%, var(--panel));
  }

  main {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
  }

  .stage {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: #08090c;
  }

  aside {
    border-left: 1px solid var(--border);
    background: var(--panel);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  footer {
    margin-top: auto;
    padding: 12px 16px;
    font-size: 11.5px;
    line-height: 2;
  }

  .drop-overlay {
    position: fixed;
    inset: 12px;
    border: 2px dashed var(--accent);
    border-radius: 16px;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    display: grid;
    place-items: center;
    font-size: 20px;
    font-weight: 600;
    pointer-events: none;
  }

  /* Narrow screens: the page scrolls, with the video stage on top and the steps below. */
  @media (max-width: 900px) {
    .shell {
      height: auto;
      min-height: 100%;
    }

    main {
      display: flex;
      flex-direction: column;
    }

    .stage {
      height: 62vh;
      min-height: 320px;
    }

    aside {
      border-left: none;
      border-top: 1px solid var(--border);
      overflow: visible;
    }

    .file {
      display: none;
    }
  }
</style>
