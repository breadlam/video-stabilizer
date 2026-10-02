<script lang="ts">
  interface Props {
    onpick: () => void
    loading: string | null
    active: boolean
  }
  let { onpick, loading, active }: Props = $props()

  const webCodecs = typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined'
</script>

<div class="wrap">
  <div class="intro">
    <h1>Pin a still point.<br />Remove the drift.</h1>
    <p class="lede">
      Mark something in your video that never moves — a fencepost, a rock, the corner of a window — and every
      frame is shifted so it stays exactly where it was.
    </p>
  </div>

  <button class="drop" class:active onclick={onpick} disabled={!!loading}>
    {#if loading}
      <span class="spinner" aria-hidden="true"></span>
      <span>{loading}</span>
    {:else}
      <svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true">
        <path
          d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <strong>Drop a video here, or click to choose one</strong>
      <span class="muted">MP4, MOV or WebM · stays on your device, nothing is uploaded</span>
    {/if}
  </button>

  {#if !webCodecs}
    <p class="warn">
      This browser lacks the WebCodecs API needed to decode and encode video. Please use a current version of Chrome,
      Edge, Safari or Firefox.
    </p>
  {/if}

  <ol class="steps">
    <li>
      <span class="n">1</span>
      <div><strong>Anchor</strong><span class="muted">Draw a box around a static detail. Two or more anchors also fix rotation.</span></div>
    </li>
    <li>
      <span class="n">2</span>
      <div><strong>Track</strong><span class="muted">Each frame is matched against the original, so no drift creeps back in.</span></div>
    </li>
    <li>
      <span class="n">3</span>
      <div><strong>Export</strong><span class="muted">Preview, pick framing, and save an MP4 with the original audio.</span></div>
    </li>
  </ol>
</div>

<style>
  .wrap {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 28px;
    padding: 56px 20px;
  }

  .intro {
    text-align: center;
    max-width: 640px;
  }

  h1 {
    font-size: clamp(28px, 4.4vw, 44px);
    line-height: 1.1;
    margin: 0 0 14px;
    letter-spacing: -0.02em;
  }

  .lede {
    color: var(--muted);
    font-size: 16px;
    margin: 0;
  }

  .drop {
    width: min(640px, 100%);
    min-height: 200px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    border: 2px dashed var(--border);
    border-radius: 16px;
    background: var(--panel);
    color: var(--text);
    transition:
      border-color 0.15s,
      background 0.15s;
  }

  .drop:hover:not(:disabled),
  .drop.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--panel));
  }

  .drop svg {
    color: var(--accent);
  }

  .warn {
    max-width: 640px;
    color: var(--warn);
    text-align: center;
  }

  .steps {
    list-style: none;
    padding: 0;
    margin: 0;
    width: min(640px, 100%);
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
  }

  .steps li {
    display: flex;
    gap: 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
  }

  .steps div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 13px;
  }

  .n {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--panel-3);
    font-size: 12px;
    font-weight: 700;
  }

  .spinner {
    width: 28px;
    height: 28px;
    border: 3px solid var(--panel-3);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 640px) {
    .steps {
      grid-template-columns: 1fr;
    }
  }
</style>
