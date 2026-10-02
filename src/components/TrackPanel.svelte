<script lang="ts">
  import { app } from '../lib/state/app.svelte'
  import Panel from './Panel.svelte'

  const run = $derived(app.tracking)
  const n = $derived(app.frameCount)
  const resumeAt = $derived(app.resumeIndex)
  const label = $derived.by(() => {
    if (!app.obs) return 'Track anchors'
    if (app.dirtyFrom !== null) return `Re-track from frame ${resumeAt + 1}`
    if (app.trackedUpTo < n) return `Continue from frame ${app.trackedUpTo + 1}`
    return 'Track again'
  })
  const percent = $derived(run && run.total ? Math.round((100 * run.processed) / run.total) : 0)
  const fps = $derived(app.lastRun && app.lastRun.seconds > 0 ? app.lastRun.frames / app.lastRun.seconds : null)
</script>

<Panel step={2} title="Track" done={app.trackingComplete} disabled={!app.anchors.length}>
  {#if run}
    <p>
      {#if run.phase === 'loading'}
        Loading the tracker (first run downloads ~13 MB)…
      {:else}
        Tracking frame {run.startIndex + run.processed} of {n}…
      {/if}
    </p>
    <div class="progress"><div style:width="{percent}%"></div></div>
    <button onclick={() => app.cancelTracking()}>Stop</button>
  {:else}
    <div class="row">
      <button
        class="primary grow"
        disabled={!app.anchors.length}
        onclick={() => app.startTracking()}
      >
        {label}
      </button>
      {#if app.obs && (app.dirtyFrom !== null || app.trackedUpTo < n)}
        <button title="Discard results and track from the first frame" onclick={() => app.startTracking(true)}>All</button>
      {/if}
    </div>
    {#if !app.anchors.length}
      <p class="muted">Add at least one anchor first.</p>
    {/if}
  {/if}

  {#if app.obs && app.trackedUpTo > 0 && !run}
    <p class="muted">
      {app.trackedUpTo === n ? `All ${n} frames tracked` : `${app.trackedUpTo} of ${n} frames tracked`}{fps
        ? ` · ${fps.toFixed(0)} frames/s`
        : ''}.
    </p>
    {#if app.problemFrames > 0}
      <p class="warn">
        {app.problemFrames} frame{app.problemFrames === 1 ? '' : 's'} with an anchor that was not found confidently
        (amber/red on the timeline). Their motion is interpolated; drag the anchor on such a frame to fix it.
      </p>
    {:else}
      <p class="ok">Every anchor was found confidently in every frame.</p>
    {/if}
  {/if}

  {#if app.corrections.length}
    <div class="row">
      <span class="grow muted">
        {app.corrections.length} correction{app.corrections.length === 1 ? '' : 's'} (◆ on the timeline){app.dirtyFrom !== null
          ? ' — re-track to apply'
          : ''}.
      </span>
      <button
        class="ghost"
        onclick={() => {
          for (const c of [...app.corrections]) app.removeCorrection(c.anchorId, c.index)
        }}>Clear</button
      >
    </div>
  {/if}
</Panel>

<style>
  .warn {
    color: var(--warn);
  }

  .ok {
    color: var(--ok);
  }
</style>
