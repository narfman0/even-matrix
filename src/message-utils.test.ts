import { describe, it, expect, vi, afterEach } from 'vitest'
import { senderColor, parseLine, visibleLines, formatAge, SENDER_COLORS, DISPLAY_MAX_LINES } from './message-utils'

afterEach(() => {
  vi.useRealTimers()
})

// ─── formatAge ────────────────────────────────────────────────────────────────

describe('formatAge', () => {
  it('returns "just now" when age is less than 60 seconds', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000000)
    expect(formatAge(1000000 - 30 * 1000)).toBe('just now')
  })

  it('returns "Xm" when age is between 1 and 59 minutes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000000)
    expect(formatAge(1000000 - 5 * 60 * 1000)).toBe('5m')
  })

  it('returns "Xh" when age is between 1 and 23 hours', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000000)
    expect(formatAge(1000000 - 3 * 60 * 60 * 1000)).toBe('3h')
  })

  it('returns "Xd" when age is 24 hours or more', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000000)
    expect(formatAge(1000000 - 2 * 24 * 60 * 60 * 1000)).toBe('2d')
  })
})

// ─── senderColor ──────────────────────────────────────────────────────────────

describe('senderColor', () => {
  it('returns a string from SENDER_COLORS', () => {
    const color = senderColor('alice')
    expect(SENDER_COLORS).toContain(color)
  })

  it('is deterministic for the same sender', () => {
    expect(senderColor('alice')).toBe(senderColor('alice'))
    expect(senderColor('bob')).toBe(senderColor('bob'))
  })

  it('different senders may return different colors', () => {
    // Not guaranteed by the algorithm, but with 8 colors and common names, most differ
    const colors = new Set(['alice', 'bob', 'charlie', 'david', 'eve', 'frank', 'grace', 'heidi'].map(senderColor))
    expect(colors.size).toBeGreaterThan(1)
  })

  it('handles empty string sender without throwing', () => {
    expect(() => senderColor('')).not.toThrow()
    expect(SENDER_COLORS).toContain(senderColor(''))
  })

  it('handles very long sender name without throwing', () => {
    const longName = 'a'.repeat(1000)
    expect(() => senderColor(longName)).not.toThrow()
    expect(SENDER_COLORS).toContain(senderColor(longName))
  })

  it('handles unicode sender names', () => {
    expect(() => senderColor('こんにちは')).not.toThrow()
    expect(SENDER_COLORS).toContain(senderColor('こんにちは'))
  })

  it('always returns a value in SENDER_COLORS regardless of input', () => {
    const inputs = ['', 'a', 'abc', '@user:matrix.org', 'User With Spaces', '123']
    for (const input of inputs) {
      expect(SENDER_COLORS).toContain(senderColor(input))
    }
  })
})

// ─── parseLine ────────────────────────────────────────────────────────────────

describe('parseLine', () => {
  it('parses a normal "sender: text" line', () => {
    expect(parseLine('alice: hello world')).toEqual({ sender: 'alice', text: 'hello world' })
  })

  it('returns null when no ": " separator is present', () => {
    expect(parseLine('no colon here')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseLine('')).toBeNull()
  })

  it('returns null when line has only a colon without space', () => {
    expect(parseLine('alice:hello')).toBeNull()
  })

  it('handles text with multiple ": " occurrences — only first split', () => {
    expect(parseLine('alice: say: something')).toEqual({ sender: 'alice', text: 'say: something' })
  })

  it('handles empty text after separator', () => {
    expect(parseLine('alice: ')).toEqual({ sender: 'alice', text: '' })
  })

  it('handles sender that looks like a matrix user id', () => {
    expect(parseLine('@user:matrix.org: hello')).toEqual({ sender: '@user:matrix.org', text: 'hello' })
  })

  it('handles text that starts with ": "', () => {
    // line = ": hello" → colon at 0, sender = "", text = "hello"
    expect(parseLine(': hello')).toEqual({ sender: '', text: 'hello' })
  })

  it('handles long sender names', () => {
    const longSender = 'a'.repeat(200)
    const result = parseLine(`${longSender}: message`)
    expect(result).toEqual({ sender: longSender, text: 'message' })
  })

  it('parses timestamp prefix "[Xm] sender: text"', () => {
    expect(parseLine('[5m] alice: hello')).toEqual({ timestamp: '5m', sender: 'alice', text: 'hello' })
  })

  it('parses "[just now] sender: text"', () => {
    expect(parseLine('[just now] alice: hi there')).toEqual({ timestamp: 'just now', sender: 'alice', text: 'hi there' })
  })

  it('parses "[2h] sender: text with colons"', () => {
    expect(parseLine('[2h] bob: say: something')).toEqual({ timestamp: '2h', sender: 'bob', text: 'say: something' })
  })

  it('returns no timestamp field for plain "sender: text" line', () => {
    const result = parseLine('alice: hello')
    expect(result).toEqual({ sender: 'alice', text: 'hello' })
    expect(result?.timestamp).toBeUndefined()
  })
})

// ─── visibleLines ─────────────────────────────────────────────────────────────

describe('visibleLines', () => {
  it('returns empty array for empty lines', () => {
    expect(visibleLines([], 0)).toEqual([])
  })

  it('returns empty array for empty lines with non-zero offset', () => {
    expect(visibleLines([], 5)).toEqual([])
  })

  it('returns lines reversed at zero offset', () => {
    const lines = ['a', 'b', 'c']
    expect(visibleLines(lines, 0)).toEqual(['c', 'b', 'a'])
  })

  it('applies scroll offset — offset 1 hides the last (newest) line', () => {
    const lines = ['a', 'b', 'c']
    expect(visibleLines(lines, 1)).toEqual(['b', 'a'])
  })

  it('offset equal to lines.length returns empty array', () => {
    const lines = ['a', 'b', 'c']
    expect(visibleLines(lines, 3)).toEqual([])
  })

  it('offset larger than lines.length returns empty array', () => {
    const lines = ['a', 'b', 'c']
    expect(visibleLines(lines, 100)).toEqual([])
  })

  it('caps output at DISPLAY_MAX_LINES when lines exceed limit', () => {
    const lines = Array.from({ length: DISPLAY_MAX_LINES + 10 }, (_, i) => `line${i}`)
    const result = visibleLines(lines, 0)
    expect(result).toHaveLength(DISPLAY_MAX_LINES)
  })

  it('with offset, still caps at DISPLAY_MAX_LINES', () => {
    const lines = Array.from({ length: DISPLAY_MAX_LINES + 20 }, (_, i) => `line${i}`)
    const result = visibleLines(lines, 5)
    expect(result).toHaveLength(DISPLAY_MAX_LINES)
  })

  it('newest visible line is at index 0 of result', () => {
    const lines = ['oldest', 'middle', 'newest']
    const result = visibleLines(lines, 0)
    expect(result[0]).toBe('newest')
  })

  it('with offset 1, second-newest is at index 0', () => {
    const lines = ['oldest', 'middle', 'newest']
    const result = visibleLines(lines, 1)
    expect(result[0]).toBe('middle')
  })

  it('does not mutate the original array', () => {
    const lines = ['a', 'b', 'c']
    const copy = [...lines]
    visibleLines(lines, 0)
    expect(lines).toEqual(copy)
  })

  it('single line with offset 0 returns that line', () => {
    expect(visibleLines(['only'], 0)).toEqual(['only'])
  })

  it('single line with offset 1 returns empty', () => {
    expect(visibleLines(['only'], 1)).toEqual([])
  })
})
