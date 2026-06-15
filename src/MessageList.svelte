<script lang="ts">
  import { visibleLines, parseLine, senderColor } from './message-utils'
  let { lines, scrollOffset, mentions = [] }: { lines: string[], scrollOffset: number, mentions?: boolean[] } = $props()

  function visibleMentions(lines: string[], mentions: boolean[], scrollOffset: number): boolean[] {
    const start = Math.max(0, lines.length - 20 - scrollOffset)
    const end = lines.length - scrollOffset
    return mentions.slice(start, end).reverse()
  }
</script>

<div class="messages">
  {#if visibleLines(lines, scrollOffset).length === 0}
    <span class="no-msg">(no messages)</span>
  {:else}
    {@const vlines = visibleLines(lines, scrollOffset)}
    {@const vmentions = visibleMentions(lines, mentions, scrollOffset)}
    {#each vlines as line, i}
      {@const parsed = parseLine(line)}
      <div class="msg-line" class:mention={vmentions[i]}>
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
  .mention { background: #2a2200; border-left: 2px solid #f7c67e; padding-left: 4px; }
</style>
