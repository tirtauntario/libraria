<script lang="ts">
  import { router } from '../../lib/router.svelte';
  import type { SourceSetupProps } from '../../lib/sources/types';
  import Icon from '../../lib/ui/Icon.svelte';

  let { onCancel }: SourceSetupProps = $props();

  function go() {
    onCancel();
    router.navigate('/join');
  }
</script>

<div class="wrap">
  <p class="muted">
    A Libraria server is a community library. Join one with an account (or an invite link) and its books show up here, ready to
    download for offline reading.
  </p>
  <div class="row">
    <button class="btn" type="button" onclick={onCancel}>Back</button>
    <button class="btn primary" type="button" onclick={go}><Icon name="plus" size={18} /> Add a server</button>
  </div>
</div>

<style>
  .wrap {
    display: grid;
    gap: 16px;
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
</style>
