<script lang="ts">
  import { visibleLines, parseLine, senderColor } from './message-utils'
  let { lines, scrollOffset }: { lines: string[], scrollOffset: number } = $props()
</script>

<div class="messages">
  {#if visibleLines(lines, scrollOffset).length === 0}
    <span class="no-msg">(no messages)</span>
  {:else}
    {#each visibleLines(lines, scrollOffset) as line}
      {@const parsed = parseLine(line)}
      <div class="msg-line">
        {#if parsed}
          {#if parsed.timestamp}<span class="msg-ts">[{parsed.timestamp}]</span>{/if}
          <span class="msg-sender" style="color: {senderColor(parsed.sender)}">{parsed.sender}:</span>
          <span class="msg-text"> {parsed.text}</span>
        {:else}
          {line}
        {/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  .messages { white-space: pre-wrap; }
  .msg-line { line-height: 1.5; }
  .msg-ts { color: #555; font-size: 11px; margin-right: 4px; }
  .msg-sender { font-weight: bold; }
  .msg-text { color: #ccc; }
  .no-msg { color: #555; }
</style>
