<script lang="ts">
  import { app } from '../lib/state/app.svelte'
  import Panel from './Panel.svelte'

  const auto = $derived(app.autoCropResult)
  const enabled = $derived(!!app.trajectory && !!auto)
  const zoom = $derived(app.crop?.zoom ?? 1)
  const keptPercent = $derived(Math.round(100 / zoom))
</script>

<Panel step={3} title="Framing" disabled={!enabled}>
  {#if !enabled}
    <p class="muted">Available after tracking.</p>
  {:else if auto}
    <div class="choices" role="radiogroup" aria-label="Zoom">
      <label class="choice">
        <input type="radio" name="zoom" checked={app.settings.zoomMode === 'auto'} onchange={() => (app.settings.zoomMode = 'auto')} />
        <span>Crop to fit <small>Zoom ×{auto.zoom.toFixed(2)}: the largest view with no empty edges.</small></span>
      </label>
      <label class="choice">
        <input
          type="radio"
          name="zoom"
          checked={app.settings.zoomMode === 'manual'}
          onchange={() => {
            app.settings.zoom = Math.min(app.settings.zoom, auto.zoom)
            app.settings.zoomMode = 'manual'
          }}
        />
        <span>Custom zoom <small>Show more of the frame; uncovered edges are filled.</small></span>
      </label>
    </div>
    {#if app.settings.zoomMode === 'manual'}
      <label class="field">
        <span class="field-head"><span>Zoom</span><span class="mono">×{zoom.toFixed(2)}</span></span>
        <input
          type="range"
          min="1"
          max={Math.max(1.0001, auto.zoom)}
          step="0.005"
          bind:value={app.settings.zoom}
        />
      </label>
    {/if}
    <label class="field">
      <span class="field-head"><span>Fill uncovered edges with</span></span>
      <select bind:value={app.settings.fill}>
        <option value="black">Black</option>
        <option value="history">Earlier frames (best for still scenes)</option>
      </select>
    </label>
    <label class="field">
      <span class="field-head">
        <span>Jitter filter</span>
        <span class="mono">{app.settings.smoothing === 0 ? 'off' : `${app.settings.smoothing} frames`}</span>
      </span>
      <input type="range" min="0" max="6" step="0.5" bind:value={app.settings.smoothing} />
    </label>
    <p class="muted">
      Output {app.outputSize?.width}×{app.outputSize?.height}, showing {keptPercent}% of the frame width.
      {#if auto.zoom > 1.25}
        <span class="warn">The drift is large, so the crop is substantial.</span>
      {/if}
    </p>
  {/if}
</Panel>

<style>
  .choices {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .warn {
    color: var(--warn);
  }
</style>
