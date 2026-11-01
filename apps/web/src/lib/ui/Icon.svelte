<script lang="ts">
  import { ICONS, type IconName } from './icons';

  let { name, size = 20, label }: { name: IconName; size?: number; label?: string } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden={label ? undefined : 'true'}
  aria-label={label}
  role={label ? 'img' : undefined}
  focusable="false"
>
  {@html ICONS[name]}
</svg>

<style>
  svg {
    flex: none;
    display: block;
  }
</style>
