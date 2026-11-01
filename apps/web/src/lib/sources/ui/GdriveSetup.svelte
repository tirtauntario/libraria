<script lang="ts">
  import type { SourceSetupProps } from '../types';
  import CloudSetup from './CloudSetup.svelte';

  let props: SourceSetupProps = $props();
</script>

<CloudSetup {...props} provider="gdrive" />
