<script lang="ts">
  import Icon from '../../ui/Icon.svelte';
  import OAuthAppField from './OAuthAppField.svelte';
</script>

<p class="subtle intro">
  To add Google Drive or Dropbox sources, this copy of Libraria needs its own app registration with each provider.
  <span class="chip"><Icon name="refresh" size={12} /> Synced</span>
</p>
<div class="providers">
  <section>
    <h3>Google Drive</h3>
    <OAuthAppField provider="gdrive" compact />
  </section>
  <section>
    <h3>Dropbox</h3>
    <OAuthAppField provider="dropbox" compact />
  </section>
</div>

<style>
  .intro {
    font-size: 13.5px;
    margin-bottom: 4px;
  }
  .providers {
    display: grid;
    gap: 8px;
  }
  section {
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  section:first-child {
    border-top: 0;
  }
  h3 {
    margin: 4px 0 8px;
    font-size: 13px;
    font-weight: 650;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-3);
  }
</style>
