<script lang="ts" generics="T extends string | number | boolean">
  import Icon from './Icon.svelte';
  import type { IconName } from './icons';

  let {
    value = $bindable(),
    options,
    label,
    onchange,
    compact = false,
  }: {
    value: T;
    options: { value: T; label: string; icon?: IconName; iconOnly?: boolean }[];
    label: string;
    onchange?: (value: T) => void;
    compact?: boolean;
  } = $props();
</script>

<div class="seg" class:compact role="radiogroup" aria-label={label}>
  {#each options as opt (String(opt.value))}
    <button
      type="button"
      role="radio"
      aria-checked={value === opt.value}
      aria-label={opt.iconOnly ? opt.label : undefined}
      title={opt.iconOnly ? opt.label : undefined}
      onclick={() => {
        value = opt.value;
        onchange?.(opt.value);
      }}
    >
      {#if opt.icon}<Icon name={opt.icon} size={18} />{/if}
      {#if !opt.iconOnly}<span>{opt.label}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .seg {
    display: inline-flex;
    padding: 3px;
    gap: 2px;
    border-radius: calc(var(--radius) + 2px);
    background: var(--surface-2);
    max-width: 100%;
  }
  button {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 34px;
    padding: 0 12px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    font-weight: 550;
    white-space: nowrap;
    transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease);
  }
  .compact button {
    min-height: 30px;
    padding: 0 9px;
  }
  button:hover {
    color: var(--text);
  }
  button[aria-checked='true'] {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-sm);
  }
</style>
