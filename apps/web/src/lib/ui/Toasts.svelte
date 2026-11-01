<script lang="ts">
  import { toasts } from '../stores/toasts.svelte';
  import Icon from './Icon.svelte';
</script>

<div class="toasts" role="region" aria-label="Notifications">
  {#each toasts.items as t (t.id)}
    <div class="toast {t.kind}" role={t.kind === 'error' ? 'alert' : 'status'}>
      <div class="text">
        <p class="msg">{t.message}</p>
        {#if t.detail}<p class="detail">{t.detail}</p>{/if}
        {#if t.progress != null}
          <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(t.progress * 100)}>
            <div style:width="{Math.round(t.progress * 100)}%"></div>
          </div>
        {/if}
      </div>
      {#if t.action}
        <button
          class="btn small ghost action"
          type="button"
          onclick={() => {
            t.action?.run();
            toasts.dismiss(t.id);
          }}>{t.action.label}</button
        >
      {/if}
      {#if t.progress == null}
        <button class="icon-btn close" type="button" aria-label="Dismiss" onclick={() => toasts.dismiss(t.id)}>
          <Icon name="close" size={16} />
        </button>
      {/if}
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    z-index: 100;
    left: 50%;
    bottom: calc(var(--nav-h) + var(--safe-bottom) + 12px);
    transform: translateX(-50%);
    width: min(440px, calc(100vw - 24px));
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
  }
  @media (min-width: 900px) {
    .toasts {
      bottom: 24px;
      left: auto;
      right: 24px;
      transform: none;
    }
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 8px 10px 16px;
    border-radius: var(--radius);
    background: #24282a;
    color: #f2efe9;
    box-shadow: var(--shadow-lg);
    animation: rise 220ms var(--ease);
    --surface-2: rgb(255 255 255 / 0.1);
  }
  .toast.error {
    background: #4a1f1b;
  }
  .toast.success .msg::before {
    content: '';
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .msg {
    font-size: 14px;
    font-weight: 550;
    overflow-wrap: anywhere;
  }
  .detail {
    margin-top: 2px;
    font-size: 12.5px;
    color: rgb(255 255 255 / 0.7);
    white-space: pre-line;
    max-height: 7.5em;
    overflow: auto;
  }
  .bar {
    margin-top: 8px;
    height: 4px;
    border-radius: 2px;
    background: rgb(255 255 255 / 0.15);
    overflow: hidden;
  }
  .bar > div {
    height: 100%;
    background: #8fd6bf;
    transition: width 200ms linear;
  }
  .action {
    color: #9fe0ca;
  }
  .close {
    width: 32px;
    height: 32px;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
  }
</style>
