<script lang="ts">
  import Icon from '../../ui/Icon.svelte';

  let { value, label }: { value: string; label: string } = $props();
  let copied = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
      setTimeout(() => (copied = false), 1800);
    } catch {
      // clipboard blocked: the text is selectable
    }
  }
</script>

<div class="copy">
  <input class="input mono" readonly {value} aria-label={label} onfocus={(e) => e.currentTarget.select()} />
  <button class="btn small" type="button" onclick={copy} aria-label="Copy {label}">
    <Icon name={copied ? 'check' : 'external'} size={16} />
    {copied ? 'Copied' : 'Copy'}
  </button>
</div>

<style>
  .copy {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .mono {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: 13px;
  }
  .btn {
    flex: none;
  }
</style>
