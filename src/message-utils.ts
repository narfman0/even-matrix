export const DISPLAY_MAX_LINES = 20

export const SENDER_COLORS = [
  '#7eb8f7', '#f7c67e', '#b8f77e', '#f77eb8',
  '#7ef7e8', '#c67ef7', '#f7f07e', '#f7907e',
]

export function senderColor(sender: string): string {
  let hash = 0
  for (let i = 0; i < sender.length; i++) hash = (hash * 31 + sender.charCodeAt(i)) >>> 0
  return SENDER_COLORS[hash % SENDER_COLORS.length]
}

export function parseLine(line: string): { sender: string; text: string } | null {
  const colon = line.indexOf(': ')
  if (colon === -1) return null
  return { sender: line.slice(0, colon), text: line.slice(colon + 2) }
}

export function visibleLines(lines: string[], scrollOffset: number): string[] {
  return lines
    .slice(Math.max(0, lines.length - DISPLAY_MAX_LINES - scrollOffset), lines.length - scrollOffset)
    .reverse()
}
