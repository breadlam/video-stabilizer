<script lang="ts">
  import { app } from '../lib/state/app.svelte'
  import Panel from './Panel.svelte'

  function useCurrentAsReference() {
    if (app.anchors.length && !confirm('Changing the reference frame removes the current anchors and tracking. Continue?')) return
    app.setReference(app.frame)
  }

  const maxRadius = $derived(app.info ? Math.round(Math.max(app.info.width, app.info.height) / 4) : 400)
</script>

<Panel step={1} title="Anchors" done={app.anchors.length > 0}>
  <div class="row">
    <span class="grow">
      Reference: <button class="link mono" onclick={() => app.seek(app.refIndex)}>frame {app.refIndex + 1}</button>
    </span>
    <button disabled={app.frame === app.refIndex} onclick={useCurrentAsReference} title="Pin anchors to their position in the current frame">
      Use current frame
    </button>
  </div>

  {#if app.anchors.length === 0}
    <p class="muted">
      {#if app.frame === app.refIndex}
        Drag a box in the video around something that never moves: a post, a rock, a building corner. Pick a detail with
        texture or edges, away from moving things like water, foliage or people.
      {:else}
        <button class="link" onclick={() => app.seek(app.refIndex)}>Go to the reference frame</button> to draw anchors.
      {/if}
    </p>
  {:else}
    <ul class="anchors">
      {#each app.anchors as a, i (a.id)}
        <li class:selected={a.id === app.selected}>
          <button class="pick" onclick={() => (app.selected = a.id)}>
            <span class="dot" style:background={a.color}></span>
            Anchor {i + 1}
            <span class="muted mono">{a.rect.w}×{a.rect.h} @ {a.rect.x + a.rect.w / 2}, {a.rect.y + a.rect.h / 2}</span>
          </button>
          <button class="ghost remove" aria-label="Remove anchor {i + 1}" onclick={() => app.removeAnchor(a.id)}>✕</button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="choices" role="radiogroup" aria-label="Motion to remove">
    <label class="choice">
      <input
        type="radio"
        name="model"
        checked={app.settings.model === 'translation'}
        onchange={() => app.setTrackingSetting('model', 'translation')}
      />
      <span>Position<small>Removes pan and tilt drift.</small></span>
    </label>
    <label class="choice">
      <input
        type="radio"
        name="model"
        checked={app.settings.model === 'rotation'}
        onchange={() => app.setTrackingSetting('model', 'rotation')}
      />
      <span
        >Position + rotation<small
          >Also removes roll{app.anchors.length >= 2 ? ' and zoom' : ''}. Most accurate with two anchors far apart.</small
        ></span
      >
    </label>
  </div>

  <details>
    <summary>Tracking options</summary>
    <div>
      <label class="field">
        <span class="field-head"><span>Search radius</span><span class="mono">{app.settings.searchRadius} px</span></span>
        <input
          type="range"
          min="8"
          max={maxRadius}
          step="1"
          value={app.settings.searchRadius}
          onchange={(e) => app.setTrackingSetting('searchRadius', +e.currentTarget.value)}
        />
      </label>
      <label class="field">
        <span class="field-head"><span>Minimum confidence</span><span class="mono">{app.settings.minScore.toFixed(2)}</span></span>
        <input
          type="range"
          min="0.5"
          max="0.98"
          step="0.01"
          value={app.settings.minScore}
          onchange={(e) => app.setTrackingSetting('minScore', +e.currentTarget.value)}
        />
      </label>
      <p class="muted small">
        Increase the radius for fast or jerky camera motion. Matches below the confidence threshold are ignored and
        filled in from neighbouring frames.
      </p>
    </div>
  </details>
</Panel>

<style>
  .link {
    border: none;
    background: none;
    padding: 0;
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .link:hover:not(:disabled) {
    background: none;
  }

  .anchors {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .anchors li {
    display: flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .anchors li.selected {
    border-color: var(--accent);
  }

  .pick {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    border: none;
    background: none;
    text-align: left;
    min-width: 0;
  }

  .pick .muted {
    margin-left: auto;
    font-size: 11.5px;
    white-space: nowrap;
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: none;
  }

  .remove {
    padding: 4px 10px;
    color: var(--muted);
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .small {
    font-size: 12px;
  }
</style>
