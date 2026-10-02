<script lang="ts">
  import { app } from '../lib/state/app.svelte'
  import Panel from './Panel.svelte'

  let projectInput: HTMLInputElement | undefined = $state()

  const run = $derived(app.exporting)
  const ready = $derived(!!app.trajectory && app.trackingComplete && !app.tracking)
  const reason = $derived(
    !app.trajectory
      ? 'Track anchors first.'
      : app.tracking
        ? 'Wait for tracking to finish.'
        : !app.trackingComplete
          ? 'Finish tracking (or re-track after corrections) first.'
          : null,
  )

  function formatSize(bytes: number): string {
    return bytes > 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`
  }

  function saveProject() {
    const blob = app.projectBlob()
    if (!blob || !app.info) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${app.info.name.replace(/\.[^.]+$/, '')}.stabilizer.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
</script>

<Panel step={4} title="Export" done={run?.phase === 'done'} disabled={!ready}>
  <label class="field">
    <span class="field-head"><span>Quality</span></span>
    <select bind:value={app.settings.quality} disabled={run?.phase === 'running'}>
      <option value="medium">Medium (smaller file)</option>
      <option value="high">High</option>
      <option value="very-high">Very high</option>
    </select>
  </label>

  {#if run?.phase === 'running'}
    <p>Encoding… {Math.round(run.progress * 100)}%</p>
    <div class="progress"><div style:width="{run.progress * 100}%"></div></div>
    <button onclick={() => app.cancelExport()}>Cancel</button>
  {:else}
    <button class="primary" disabled={!ready} onclick={() => app.startExport()}>Export MP4</button>
    {#if reason}<p class="muted">{reason}</p>{/if}
  {/if}

  {#if run?.phase === 'done'}
    {#if run.url}
      <a class="download" href={run.url} download={run.fileName}>
        Download {run.fileName}
        {#if run.size}<span class="muted">({formatSize(run.size)})</span>{/if}
      </a>
    {:else}
      <p class="ok">Saved {run.fileName}.</p>
    {/if}
    <p class="muted">{run.message}{app.info?.hasAudio ? ' Audio is copied from the original.' : ''}</p>
    {#each run.warnings ?? [] as w (w)}<p class="warn">{w}</p>{/each}
  {:else if run?.phase === 'error'}
    <p class="bad">Export failed: {run.message}</p>
  {:else if run?.phase === 'cancelled'}
    <p class="muted">Export cancelled.</p>
  {/if}

  <div class="row project">
    <button class="ghost" onclick={saveProject} title="Save anchors, corrections and tracking data">Save project</button>
    <button class="ghost" onclick={() => projectInput?.click()}>Load project…</button>
    <input
      bind:this={projectInput}
      type="file"
      accept=".json,application/json"
      class="sr-only"
      onchange={(e) => {
        const f = e.currentTarget.files?.[0]
        if (f) void app.loadProject(f)
        e.currentTarget.value = ''
      }}
    />
  </div>
</Panel>

<style>
  .download {
    display: block;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--ok) 50%, var(--border));
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--ok) 10%, transparent);
    color: var(--text);
    text-decoration: none;
    font-weight: 600;
  }

  .ok {
    color: var(--ok);
  }

  .warn {
    color: var(--warn);
  }

  .bad {
    color: var(--bad);
  }

  .project {
    margin-top: 4px;
    justify-content: space-between;
  }

  .project button {
    font-size: 12.5px;
    color: var(--muted);
  }
</style>
