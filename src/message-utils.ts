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

export function formatAge(ts: number): string {
  const ageMs = Date.now() - ts
  const ageSec = Math.floor(ageMs / 1000)
  if (ageSec < 60) return 'just now'
  const ageMin = Math.floor(ageSec / 60)
  if (ageMin < 60) return `${ageMin}m`
  const ageHr = Math.floor(ageMin / 60)
  if (ageHr < 24) return `${ageHr}h`
  return `${Math.floor(ageHr / 24)}d`
}

export function parseLine(line: string): { timestamp?: string; sender: string; text: string } | null {
  // Try to parse "[Xm] sender: text" or "[just now] sender: text"
  const tsMatch = line.match(/^\[([^\]]+)\] (.+)$/)
  if (tsMatch) {
    const rest = tsMatch[2]
    const colon = rest.indexOf(': ')
    if (colon !== -1) {
      return { timestamp: tsMatch[1], sender: rest.slice(0, colon), text: rest.slice(colon + 2) }
    }
  }
  // Fall back to plain "sender: text"
  const colon = line.indexOf(': ')
  if (colon === -1) return null
  return { sender: line.slice(0, colon), text: line.slice(colon + 2) }
}

export function visibleLines(lines: string[], scrollOffset: number): string[] {
  return lines
    .slice(Math.max(0, lines.length - DISPLAY_MAX_LINES - scrollOffset), lines.length - scrollOffset)
    .reverse()
}
