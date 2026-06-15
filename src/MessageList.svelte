<script lang="ts">
  import { visibleLines, parseLine, senderColor } from './message-utils'
  let { lines, scrollOffset, mentions = [] }: { lines: string[], scrollOffset: number, mentions?: boolean[] } = $props()

  function visibleMentions(lines: string[], mentions: boolean[], scrollOffset: number): boolean[] {
    const start = Math.max(0, lines.length - 20 - scrollOffset)
    const end = lines.length - scrollOffset
    return mentions.slice(start, end).reverse()
  }

  function isReplyQuote(line: string): boolean {
    return line.startsWith('  ↩ ')
  }

  function splitReactions(line: string): { msg: string; reacts: string[] } {
    const idx = line.indexOf('||REACT:')
    if (idx === -1) return { msg: line, reacts: [] }
    return { msg: line.slice(0, idx), reacts: line.slice(idx + 8).split(',').filter(Boolean) }
  }
</script>

<div class="messages">
  {#if visibleLines(lines, scrollOffset).length === 0}
    <span class="no-msg">(no messages)</span>
  {:else}
    {@const vlines = visibleLines(lines, scrollOffset)}
    {@const vmentions = visibleMentions(lines, mentions, scrollOffset)}
    {#each vlines as line, i}
      {#if isReplyQuote(line)}
        <div class="reply-quote">{line.slice(4)}</div>
      {:else}
        {@const { msg, reacts } = splitReactions(line)}
        {@const parsed = parseLine(msg)}
        <div class="msg-line" class:mention={vmentions[i]}>
          {#if parsed}
            {#if parsed.timestamp}<span class="msg-ts">[{parsed.timestamp}]</span>{/if}
            <span class="msg-sender" style="color: {senderColor(parsed.sender)}">{parsed.sender}:</span>
            <span class="msg-text"> {parsed.text}</span>
          {:else}
            {msg}
          {/if}
          {#if reacts.length}
            <div class="reactions">
              {#each reacts as r}
                <span class="react-chip">{r}</span>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
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
  .reply-quote {
    font-size: 11px; color: #666; border-left: 2px solid #444;
    padding: 2px 0 2px 6px; margin: 2px 0 0 0; font-style: italic;
  }
  .reactions { margin-top: 2px; }
  .react-chip {
    font-size: 11px; background: #2a2a2a; border: 1px solid #444;
    border-radius: 8px; padding: 1px 6px; margin: 2px 2px 0 0;
    display: inline-block;
  }
</style>
