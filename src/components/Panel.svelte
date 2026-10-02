<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    step: number
    title: string
    done?: boolean
    disabled?: boolean
    children: Snippet
  }
  let { step, title, done = false, disabled = false, children }: Props = $props()
</script>

<section class="panel" class:disabled>
  <h2>
    <span class="step" class:done>{done ? '✓' : step}</span>
    {title}
  </h2>
  <div class="body">
    {@render children()}
  </div>
</section>

<style>
  .panel {
    padding: 14px 16px 16px;
    border-bottom: 1px solid var(--border);
  }

  .panel.disabled .body {
    opacity: 0.5;
  }

  h2 {
    margin: 0 0 10px;
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .step {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--panel-3);
    display: grid;
    place-items: center;
    font-size: 11px;
    letter-spacing: 0;
  }

  .step.done {
    background: color-mix(in srgb, var(--ok) 30%, var(--panel-3));
    color: var(--ok);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 13px;
  }

  .body :global(p) {
    margin: 0;
  }

  .body :global(.row) {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .body :global(.row > .grow) {
    flex: 1;
  }

  .body :global(label.field) {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .body :global(.field-head) {
    display: flex;
    justify-content: space-between;
    color: var(--muted);
    font-size: 12px;
  }

  .body :global(.progress) {
    height: 6px;
    border-radius: 3px;
    background: var(--panel-3);
    overflow: hidden;
  }

  .body :global(.progress > div) {
    height: 100%;
    background: var(--accent);
    transition: width 0.15s;
  }

  .body :global(.choice) {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .body :global(.choice:has(input:checked)) {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }

  .body :global(.choice input) {
    margin: 3px 0 0;
    accent-color: var(--accent);
  }

  .body :global(.choice span) {
    display: flex;
    flex-direction: column;
  }

  .body :global(.choice small) {
    color: var(--muted);
    font-size: 12px;
  }

  .body :global(details summary) {
    cursor: pointer;
    color: var(--muted);
    font-size: 12px;
  }

  .body :global(details[open] summary) {
    margin-bottom: 8px;
  }

  .body :global(details > div) {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
</style>
