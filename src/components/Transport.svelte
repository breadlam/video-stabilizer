<script lang="ts">
  import { formatTime } from '../lib/media/video'
  import { app } from '../lib/state/app.svelte'

  const time = $derived(app.info ? formatTime(app.info.timestamps[app.frame] - app.info.timestamps[0]) : '')
  const next = $derived(app.problemFrames > 0 ? app.nextProblem(app.frame) : null)
</script>

<div class="transport">
  <div class="group">
    <button class="ghost icon" title="First frame (Home)" aria-label="First frame" onclick={() => app.seek(0)}>
      <svg viewBox="0 0 24 24"><path d="M6 5v14M19 5l-9 7 9 7z" /></svg>
    </button>
    <button class="ghost icon" title="Previous frame (←)" aria-label="Previous frame" onclick={() => app.step(-1)}>
      <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg>
    </button>
    <button class="icon play" title="Play / pause (Space)" aria-label={app.playing ? 'Pause' : 'Play'} onclick={() => app.togglePlay()}>
      {#if app.playing}
        <svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14" /></svg>
      {:else}
        <svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" class="fill" /></svg>
      {/if}
    </button>
    <button class="ghost icon" title="Next frame (→)" aria-label="Next frame" onclick={() => app.step(1)}>
      <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>
    </button>
    <button class="ghost icon" title="Last frame (End)" aria-label="Last frame" onclick={() => app.seek(app.frameCount - 1)}>
      <svg viewBox="0 0 24 24"><path d="M18 5v14M5 5l9 7-9 7z" /></svg>
    </button>
  </div>

  <div class="pos mono">
    <span>Frame {app.frame + 1}<span class="muted">{' / '}{app.frameCount}</span></span>
    <span class="muted">{time}</span>
    {#if app.frame === app.refIndex}<span class="ref">reference</span>{/if}
  </div>

  <div class="group right">
    {#if next !== null}
      <button class="warn" title="Jump to the next frame where an anchor was not found confidently" onclick={() => app.seek(next)}>
        Next issue
      </button>
    {/if}
    <div class="segmented" role="radiogroup" aria-label="View">
      <button role="radio" aria-checked={app.view === 'original'} class:on={app.view === 'original'} onclick={() => (app.view = 'original')}>
        Original
      </button>
      <button
        role="radio"
        aria-checked={app.view === 'stabilized'}
        class:on={app.view === 'stabilized'}
        disabled={!app.trajectory}
        title={app.trajectory ? 'Stabilized preview (V)' : 'Track anchors first'}
        onclick={() => (app.view = 'stabilized')}
      >
        Stabilized
      </button>
    </div>
  </div>
</div>

<style>
  .transport {
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 12px 10px;
    background: var(--panel);
    flex-wrap: wrap;
  }

  .group {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .right {
    margin-left: auto;
    gap: 8px;
  }

  .icon {
    width: 34px;
    height: 32px;
    padding: 0;
    display: grid;
    place-items: center;
  }

  .icon svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .icon svg .fill {
    fill: currentColor;
  }

  .play {
    width: 40px;
    margin: 0 4px;
    background: var(--panel-3);
  }

  .pos {
    display: flex;
    gap: 12px;
    font-size: 12.5px;
    align-items: center;
  }

  .ref {
    color: var(--accent);
    font-family: inherit;
  }

  .warn {
    border-color: color-mix(in srgb, var(--warn) 50%, var(--border));
    color: var(--warn);
    font-size: 12.5px;
  }

  .segmented {
    display: flex;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .segmented button {
    border: none;
    border-radius: 0;
    background: transparent;
    font-size: 12.5px;
    padding: 6px 12px;
  }

  .segmented button.on {
    background: var(--accent-strong);
    color: white;
  }
</style>
