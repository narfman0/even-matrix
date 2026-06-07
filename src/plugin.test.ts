import { describe, it, expect, vi, afterEach } from 'vitest'
import { createPlugin } from './plugin'
import { makeMockBridge } from './__mocks__/bridge'
import { makeFakeMatrixClient, type FakeMatrixClient } from './__mocks__/matrix-client'

vi.mock('@evenrealities/even_hub_sdk', () => ({
  RebuildPageContainer: vi.fn((opts: any) => opts),
  TextContainerProperty: vi.fn((opts: any) => opts),
  TextContainerUpgrade: vi.fn((opts: any) => opts),
  ListContainerProperty: vi.fn((opts: any) => opts),
  ListItemContainerProperty: vi.fn((opts: any) => opts),
  OsEventTypeList: {
    CLICK_EVENT: 'CLICK',
    SCROLL_TOP_EVENT: 'SCROLL_TOP',
    SCROLL_BOTTOM_EVENT: 'SCROLL_BOTTOM',
    DOUBLE_CLICK_EVENT: 'DOUBLE_CLICK',
  },
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function makePlugin(whisperUrl: string | null = null) {
  const bridge = makeMockBridge()
  const matrix = makeFakeMatrixClient()
  const plugin = createPlugin(bridge, matrix, whisperUrl)
  return { bridge, plugin, matrix }
}

const DEFAULT_ROOM = { id: 'room-1', name: 'Room' }

async function seedRooms(
  matrix: FakeMatrixClient,
  plugin: ReturnType<typeof createPlugin>,
  rooms: Array<{ id: string; name: string }>
) {
  matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [], spaces: [], orphans: rooms }, nextBatch: 'batch-0' })
  await plugin.start(null)
}

async function goToMessages(
  matrix: FakeMatrixClient,
  plugin: ReturnType<typeof createPlugin>,
  messages: Array<{ sender: string; text: string }> = []
) {
  if (plugin.getState().displayedRooms.length === 0) {
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [], spaces: [], orphans: [DEFAULT_ROOM] }, nextBatch: 'batch-0' })
    await plugin.start(null)
  }
  matrix.fetchHistory.mockResolvedValueOnce({
    messages: messages.map((m, i) => ({ event_id: `ev-${i}`, sender: m.sender, text: m.text, ts: 0 })),
    prevBatch: null,
  })
  await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
}

// ─── showRoomList ─────────────────────────────────────────────────────────────

describe('showRoomList', () => {
  it('renders rooms in the order received (backend sorts)', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    await seedRooms(matrix, plugin, [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }])
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.listObject[0].itemContainer.itemName).toEqual(['Alpha', 'Beta'])
  })

  it('shows all rooms without capping', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    const rooms = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, name: `Room ${i}` }))
    await seedRooms(matrix, plugin, rooms)
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.listObject[0].itemContainer.itemName).toHaveLength(25)
  })

  it('truncates room names to 64 chars', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    await seedRooms(matrix, plugin, [{ id: 'x', name: 'A'.repeat(70) }])
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.listObject[0].itemContainer.itemName[0]).toHaveLength(64)
  })

  it('sets view to rooms', async () => {
    const { plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin)
    await plugin.showRoomList()
    expect(plugin.getState().view).toBe('rooms')
  })
})

// ─── showMessageView ──────────────────────────────────────────────────────────

describe('showMessageView', () => {
  it('shows all messages in order (newest first)', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(matrix, plugin, messages)
    const arg = bridge.rebuildPageContainer.mock.calls.at(-1)![0]
    const lines = arg.textObject[0].content.split('\n')
    expect(lines).toHaveLength(10)
    expect(lines[0]).toContain('A: msg9')
    expect(lines[9]).toContain('A: msg0')
  })

  it('drops oldest messages when byte budget is exceeded', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    const longMsg = 'x'.repeat(200)
    const messages = Array.from({ length: 8 }, (_, i) => ({ sender: 'A', text: `${i}:${longMsg}` }))
    await goToMessages(matrix, plugin, messages)
    const arg = bridge.rebuildPageContainer.mock.calls.at(-1)![0]
    const content = arg.textObject[0].content
    expect(content.length).toBeLessThanOrEqual(999)
    expect(content).toContain(`A: 7:${longMsg}`)
  })

  it('shows truncated message instead of "(no messages)" when single message exceeds budget', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    const hugeMsg = 'z'.repeat(1100)
    await goToMessages(matrix, plugin, [{ sender: 'A', text: hugeMsg }])
    const arg = bridge.rebuildPageContainer.mock.calls.at(-1)![0]
    const content = arg.textObject[0].content
    expect(content).not.toBe('(no messages)')
    expect(content.length).toBeLessThanOrEqual(999)
    expect(content).toContain('A: ')
  })

  it('shows fallback when no messages', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin, [])
    const arg = bridge.rebuildPageContainer.mock.calls.at(-1)![0]
    expect(arg.textObject[0].content).toBe('(no messages)')
  })

  it('sets view to messages', async () => {
    const { plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin)
    expect(plugin.getState().view).toBe('messages')
  })
})

// ─── appendLine ───────────────────────────────────────────────────────────────

describe('appendLine', () => {
  it('pushes line to lines array', async () => {
    const { plugin } = makePlugin()
    await plugin.appendLine('hello')
    expect(plugin.getState().lines).toContain('hello')
  })

  it('calls textContainerUpgrade in messages view', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin)
    bridge.textContainerUpgrade.mockClear()
    await plugin.appendLine('hello')
    expect(bridge.textContainerUpgrade).toHaveBeenCalledOnce()
  })

  it('does not call textContainerUpgrade in rooms view', async () => {
    const { bridge, plugin } = makePlugin()
    await plugin.appendLine('hello')
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
  })

  it('drops oldest lines on upgrade when byte budget is exceeded', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    const longMsg = 'x'.repeat(200)
    const messages = Array.from({ length: 6 }, (_, i) => ({ sender: 'A', text: `${i}:${longMsg}` }))
    await goToMessages(matrix, plugin, messages)
    bridge.textContainerUpgrade.mockClear()
    await plugin.appendLine(`new:${longMsg}`)
    const arg = bridge.textContainerUpgrade.mock.calls[0][0]
    expect(arg.content.length).toBeLessThanOrEqual(999)
    expect(arg.content).toContain(`new:${longMsg}`)
  })
})

// ─── start() ─────────────────────────────────────────────────────────────────

describe('start()', () => {
  it('fetches room list and shows room list', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [], spaces: [], orphans: [{ id: 'r1', name: 'Room1' }] }, nextBatch: 'batch-0' })
    await plugin.start(null)
    expect(matrix.initialSync).toHaveBeenCalledOnce()
    expect(bridge.rebuildPageContainer).toHaveBeenCalled()
  })

  it('passes persisted sync token to startSyncLoop when available', async () => {
    const { plugin, matrix } = makePlugin()
    await plugin.start('s_abc123')
    expect(matrix.startSyncLoop).toHaveBeenCalledWith('s_abc123', expect.any(Function), expect.any(Function))
  })

  it('uses nextBatch from initialSync when no persisted token', async () => {
    const { plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [], spaces: [], orphans: [] }, nextBatch: 's_fresh' })
    await plugin.start(null)
    expect(matrix.startSyncLoop).toHaveBeenCalledWith('s_fresh', expect.any(Function), expect.any(Function))
  })

  it('sets matrixConnected to true', async () => {
    const { plugin } = makePlugin()
    await plugin.start(null)
    expect(plugin.getState().matrixConnected).toBe(true)
  })
})

// ─── sync message handling ────────────────────────────────────────────────────

describe('sync message handling', () => {
  it('appends message when room matches selected room', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [], spaces: [], orphans: [{ id: 'room-1', name: 'Room1' }] }, nextBatch: 'batch-0' })
    await plugin.start(null)
    matrix.fetchHistory.mockResolvedValueOnce({ messages: [], prevBatch: null })
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    bridge.textContainerUpgrade.mockClear()
    await matrix.triggerSyncMessage('room-1', 'ev-new', 'Bob', 'Hey')
    expect(bridge.textContainerUpgrade).toHaveBeenCalled()
  })

  it('ignores message when room does not match', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [], spaces: [], orphans: [{ id: 'room-1', name: 'Room1' }] }, nextBatch: 'batch-0' })
    await plugin.start(null)
    matrix.fetchHistory.mockResolvedValueOnce({ messages: [], prevBatch: null })
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    bridge.textContainerUpgrade.mockClear()
    await matrix.triggerSyncMessage('room-2', 'ev-new', 'Eve', 'X')
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
  })

  it('deduplicates messages by event_id', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [], spaces: [], orphans: [{ id: 'room-1', name: 'Room1' }] }, nextBatch: 'batch-0' })
    await plugin.start(null)
    matrix.fetchHistory.mockResolvedValueOnce({ messages: [{ event_id: 'ev-1', sender: 'Alice', text: 'Hi', ts: 0 }], prevBatch: null })
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    bridge.textContainerUpgrade.mockClear()
    // Same event_id already seen in fetchHistory — should be ignored
    await matrix.triggerSyncMessage('room-1', 'ev-1', 'Alice', 'Hi')
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
  })

  it('updates syncToken when sync token callback fires', async () => {
    const { plugin, matrix } = makePlugin()
    await plugin.start(null)
    matrix.triggerSyncToken('s_new_token')
    expect(plugin.getState().syncToken).toBe('s_new_token')
  })
})

// ─── room selection ───────────────────────────────────────────────────────────

describe('room selection', () => {
  it('calls fetchHistory and shows messages', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    await seedRooms(matrix, plugin, [{ id: 'r1', name: 'Room' }])
    matrix.fetchHistory.mockResolvedValueOnce({ messages: [{ event_id: 'ev1', sender: 'Alice', text: 'Hi', ts: 0 }], prevBatch: null })
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    expect(matrix.fetchHistory).toHaveBeenCalledWith('r1', 50, null, expect.any(AbortSignal))
    const arg = bridge.rebuildPageContainer.mock.calls.at(-1)![0]
    expect(arg.textObject[0].content).toContain('Alice: Hi')
  })

  it('sets selectedRoomId', async () => {
    const { plugin, matrix } = makePlugin()
    await seedRooms(matrix, plugin, [{ id: 'room-a', name: 'Alpha' }, { id: 'room-b', name: 'Beta' }])
    matrix.fetchHistory.mockResolvedValueOnce({ messages: [], prevBatch: null })
    await plugin.handleEvenHubEvent({ listEvent: { eventType: 'CLICK', currentSelectItemIndex: 1 } })
    expect(plugin.getState().selectedRoomId).toBe('room-b')
    expect(matrix.fetchHistory).toHaveBeenCalledWith('room-b', 50, null, expect.any(AbortSignal))
  })
})

// ─── loadMoreHistory ─────────────────────────────────────────────────────────

describe('loadMoreHistory', () => {
  it('fetches older messages using prevBatch and prepends to lines', async () => {
    const { plugin, matrix } = makePlugin()
    await seedRooms(matrix, plugin, [{ id: 'r1', name: 'Room' }])
    matrix.fetchHistory.mockResolvedValueOnce({
      messages: [{ event_id: 'ev2', sender: 'B', text: 'newer', ts: 1 }],
      prevBatch: 'tok_abc',
    })
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    expect(plugin.getState().prevBatch).toBe('tok_abc')

    matrix.fetchHistory.mockResolvedValueOnce({
      messages: [{ event_id: 'ev1', sender: 'A', text: 'older', ts: 0 }],
      prevBatch: null,
    })
    await plugin.loadMoreHistory()
    expect(matrix.fetchHistory).toHaveBeenLastCalledWith('r1', 50, 'tok_abc')
    const { lines, prevBatch } = plugin.getState()
    expect(lines[0]).toContain('A: older')
    expect(lines[1]).toContain('B: newer')
    expect(prevBatch).toBeNull()
  })

  it('shows "Loading older messages..." on glasses when loadMoreHistory fires', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    await seedRooms(matrix, plugin, [{ id: 'r1', name: 'Room' }])
    matrix.fetchHistory.mockResolvedValueOnce({
      messages: [{ event_id: 'ev1', sender: 'A', text: 'msg', ts: 0 }],
      prevBatch: 'tok_load',
    })
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    bridge.textContainerUpgrade.mockClear()

    matrix.fetchHistory.mockResolvedValueOnce({ messages: [], prevBatch: null })
    await plugin.loadMoreHistory()

    const calls = bridge.textContainerUpgrade.mock.calls
    const loadingCall = calls.find((c: any) => c[0].content === 'Loading older messages...')
    expect(loadingCall).toBeDefined()
  })

  it('does nothing when prevBatch is null', async () => {
    const { plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin)
    matrix.fetchHistory.mockClear()
    await plugin.loadMoreHistory()
    expect(matrix.fetchHistory).not.toHaveBeenCalled()
  })

  it('prefetch: scroll triggers loadMoreHistory one page before end', async () => {
    const { plugin, matrix } = makePlugin()
    await seedRooms(matrix, plugin, [{ id: 'r1', name: 'Room' }])
    // 5 messages, prevBatch set — with SCROLL_STEP=3, threshold = 5-3-1 = 1
    // First scroll goes 0→3 (normal), second scroll: 3 >= 1 → triggers loadMoreHistory
    matrix.fetchHistory.mockResolvedValueOnce({
      messages: Array.from({ length: 5 }, (_, i) => ({ event_id: `ev${i}`, sender: 'A', text: `m${i}`, ts: 0 })),
      prevBatch: 'tok_prefetch',
    })
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    expect(plugin.getState().prevBatch).toBe('tok_prefetch')

    // First scroll: offset goes 0→3 (0 < threshold=1 is false so it scrolls normally)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })
    expect(plugin.getState().scrollOffset).toBe(3)

    // Set up load-more response
    matrix.fetchHistory.mockResolvedValueOnce({ messages: [], prevBatch: null })

    // Second scroll: scrollOffset=3 >= threshold=1, triggers loadMoreHistory
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })

    // fetchHistory: 1 for initial room load + 1 for prefetch loadMoreHistory
    expect(matrix.fetchHistory).toHaveBeenCalledTimes(2)
  })

  it('concurrent calls only fire one fetch (loadingMore guard)', async () => {
    const { plugin, matrix } = makePlugin()
    await seedRooms(matrix, plugin, [{ id: 'r1', name: 'Room' }])
    matrix.fetchHistory.mockResolvedValueOnce({
      messages: [{ event_id: 'ev1', sender: 'A', text: 'first', ts: 0 }],
      prevBatch: 'tok_old',
    })
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    expect(plugin.getState().prevBatch).toBe('tok_old')

    // Set up a slow fetch that we can resolve manually
    let resolveFetch!: (value: any) => void
    const slowFetch = new Promise<any>(resolve => { resolveFetch = resolve })
    matrix.fetchHistory.mockReturnValueOnce(slowFetch)

    // Fire two concurrent loadMoreHistory calls
    const p1 = plugin.loadMoreHistory()
    const p2 = plugin.loadMoreHistory()

    resolveFetch({ messages: [], prevBatch: null })
    await Promise.all([p1, p2])

    // fetchHistory should have only been called once (the second call was guarded)
    expect(matrix.fetchHistory).toHaveBeenCalledTimes(2) // 1 from goToMessages + 1 from loadMoreHistory
  })
})

// ─── EvenHub event handler ────────────────────────────────────────────────────

describe('handleEvenHubEvent', () => {
  it('list scroll does not select room', async () => {
    const { plugin, matrix } = makePlugin()
    await seedRooms(matrix, plugin, [{ id: 'a', name: 'Alpha' }])
    await plugin.handleEvenHubEvent({ listEvent: { eventType: 'SCROLL_TOP', currentSelectItemIndex: 0 } })
    expect(plugin.getState().selectedRoomId).toBeNull()
    expect(matrix.fetchHistory).not.toHaveBeenCalled()
  })

  it('double click in messages view starts audio and shows listening screen', async () => {
    const { bridge, plugin, matrix } = makePlugin('http://whisper:8080')
    await goToMessages(matrix, plugin)
    bridge.rebuildPageContainer.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    expect(bridge.audioControl).toHaveBeenCalledWith(true)
    expect(plugin.getState().recognizing).toBe(true)
    expect(plugin.getState().view).toBe('listening')
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.textObject[0].content).toBe('Listening...')
  })

  it('double click does nothing when no whisper URL configured', async () => {
    const { bridge, plugin, matrix } = makePlugin(null)
    await goToMessages(matrix, plugin)
    bridge.rebuildPageContainer.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    expect(bridge.audioControl).not.toHaveBeenCalled()
    expect(plugin.getState().recognizing).toBe(false)
    expect(plugin.getState().view).toBe('messages')
  })

  it('tap in listening view stops audio after cooldown', async () => {
    vi.useFakeTimers()
    const { bridge, plugin, matrix } = makePlugin('http://whisper:8080')
    await goToMessages(matrix, plugin)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    expect(plugin.getState().view).toBe('listening')
    bridge.audioControl.mockClear()
    // Within cooldown — click ignored (physical device race protection)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'CLICK' } })
    expect(bridge.audioControl).not.toHaveBeenCalled()
    expect(plugin.getState().recognizing).toBe(true)
    // After cooldown expires, click stops audio
    vi.advanceTimersByTime(1001)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'CLICK' } })
    expect(bridge.audioControl).toHaveBeenCalledWith(false)
    expect(plugin.getState().recognizing).toBe(false)
    expect(plugin.getState().view).toBe('messages')
  })

  it('double click immediately after starting audio ignored (physical device race)', async () => {
    vi.useFakeTimers()
    const { bridge, plugin, matrix } = makePlugin('http://whisper:8080')
    await goToMessages(matrix, plugin)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    bridge.audioControl.mockClear()
    // Rapid follow-up event — ignored within cooldown
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    expect(bridge.audioControl).not.toHaveBeenCalled()
    expect(plugin.getState().recognizing).toBe(true)
    // After cooldown, stops audio
    vi.advanceTimersByTime(1001)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    expect(bridge.audioControl).toHaveBeenCalledWith(false)
    expect(bridge.audioControl).not.toHaveBeenCalledWith(true)
  })

  it('back gesture (no eventType) navigates to rooms', async () => {
    vi.useFakeTimers()
    const { bridge, plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin)
    vi.advanceTimersByTime(501)
    bridge.rebuildPageContainer.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: undefined } })
    expect(bridge.rebuildPageContainer).toHaveBeenCalled()
    expect(plugin.getState().view).toBe('rooms')
  })

  it('back gesture in listening view stops audio and returns to messages', async () => {
    vi.useFakeTimers()
    const { bridge, plugin, matrix } = makePlugin('http://whisper:8080')
    await goToMessages(matrix, plugin)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    expect(plugin.getState().view).toBe('listening')
    bridge.audioControl.mockClear()
    vi.advanceTimersByTime(1001)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: undefined } })
    expect(bridge.audioControl).toHaveBeenCalledWith(false)
    expect(plugin.getState().recognizing).toBe(false)
    expect(plugin.getState().view).toBe('messages')
  })

  it('sysEvent ignored when view is rooms', async () => {
    const { bridge, plugin } = makePlugin()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: undefined } })
    expect(bridge.rebuildPageContainer).not.toHaveBeenCalled()
  })

  it('scroll down goes into history', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(matrix, plugin, messages)
    bridge.textContainerUpgrade.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })
    expect(plugin.getState().scrollOffset).toBe(3)
    const content = bridge.textContainerUpgrade.mock.calls[0][0].content
    expect(content).toContain('msg0')
    expect(content).not.toContain('msg9')
  })

  it('scroll up returns to latest messages', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(matrix, plugin, messages)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })
    bridge.textContainerUpgrade.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_TOP' } })
    expect(plugin.getState().scrollOffset).toBe(0)
    const content = bridge.textContainerUpgrade.mock.calls[0][0].content
    expect(content).toContain('msg9')
  })

  it('scroll offset does not go below zero', async () => {
    const { plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_TOP' } })
    expect(plugin.getState().scrollOffset).toBe(0)
  })

  it('new messages do not update display while scrolled into history', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(matrix, plugin, messages)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })
    expect(plugin.getState().scrollOffset).toBeGreaterThan(0)
    bridge.textContainerUpgrade.mockClear()
    await plugin.appendLine('new message')
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
  })

  it('new messages update display when at the top (offset 0)', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin)
    bridge.textContainerUpgrade.mockClear()
    await plugin.appendLine('new message')
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1)
  })

  it('entering a room resets scroll offset to 0', async () => {
    const { plugin, matrix } = makePlugin()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(matrix, plugin, messages)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })
    expect(plugin.getState().scrollOffset).toBe(3)
    await plugin.showMessageView([])
    expect(plugin.getState().scrollOffset).toBe(0)
  })

  it('audioEvent updates audioLevel to > 0 for non-silent PCM', async () => {
    const { plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin)
    await plugin.startAudio()
    // PCM: two bytes = one signed 16-bit sample at value 0x7FFF (max positive)
    // little-endian: low byte = 0xFF, high byte = 0x7F
    const pcm = new Uint8Array([0xFF, 0x7F])
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: pcm } })
    expect(plugin.getState().audioLevel).toBeGreaterThan(0)
  })

  it('audioEvent accumulates PCM chunks', async () => {
    const { plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin)
    await plugin.startAudio()
    const pcm1 = new Uint8Array([0x00, 0x01])
    const pcm2 = new Uint8Array([0x02, 0x03])
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: pcm1 } })
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: pcm2 } })
    // Verify chunks are accumulated (indirectly: stopAudio without whisperUrl discards them without error)
    await plugin.stopAudio()
    expect(plugin.getState().view).toBe('messages')
  })

  it('audio buffer cap: chunks beyond 10 MB are dropped and WAV payload stays within limit', async () => {
    const AUDIO_MAX_BYTES = 10 * 1024 * 1024
    const WAV_HEADER = 44
    const whisperUrl = 'http://whisper'
    const { plugin, matrix } = makePlugin(whisperUrl)
    await goToMessages(matrix, plugin)

    // Mock fetch to capture the FormData body size
    let capturedWavSize = -1
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: any) => {
      if (opts?.body instanceof FormData) {
        const file: File = (opts.body as FormData).get('file') as File
        if (file) capturedWavSize = file.size
      }
      return { ok: true, headers: { get: () => null }, json: async () => ({ text: '' }) }
    }))

    await plugin.startAudio()

    // Send a chunk just under the cap, then another that would push past it
    const bigChunk = new Uint8Array(AUDIO_MAX_BYTES - 10)
    const overflowChunk = new Uint8Array(100)
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: bigChunk } })
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: overflowChunk } })

    await plugin.stopAudio()

    // WAV = 44 header + PCM bytes; total PCM must not exceed AUDIO_MAX_BYTES
    expect(capturedWavSize).toBeGreaterThan(0)
    expect(capturedWavSize).toBeLessThanOrEqual(AUDIO_MAX_BYTES + WAV_HEADER)
  })
})

// ─── startAudio / stopAudio ───────────────────────────────────────────────────

describe('startAudio', () => {
  it('opens mic and sets recognizing immediately', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin)
    await plugin.startAudio()
    expect(bridge.audioControl).toHaveBeenCalledWith(true)
    expect(plugin.getState().recognizing).toBe(true)
  })

  it('shows listening screen and sets view immediately', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin)
    bridge.rebuildPageContainer.mockClear()
    await plugin.startAudio()
    expect(plugin.getState().view).toBe('listening')
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.textObject[0].content).toBe('Listening...')
  })
})

describe('stopAudio', () => {
  it('turns off mic and clears recognizing', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin)
    await plugin.startAudio()
    bridge.audioControl.mockClear()
    await plugin.stopAudio()
    expect(bridge.audioControl).toHaveBeenCalledWith(false)
    expect(plugin.getState().recognizing).toBe(false)
  })

  it('re-renders messages view at bottom so user lands back in the room', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin, [{ sender: 'Alice', text: 'Hi' }])
    await plugin.startAudio()
    bridge.rebuildPageContainer.mockClear()
    await plugin.stopAudio()
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce()
    expect(plugin.getState().view).toBe('messages')
    expect(plugin.getState().scrollOffset).toBe(0)
  })

  it('without whisperUrl discards audioBuf and does not call sendMessage', async () => {
    const { plugin, matrix } = makePlugin(null)
    await goToMessages(matrix, plugin)
    await plugin.startAudio()
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: new Uint8Array([0x00, 0x01]) } })
    await plugin.stopAudio()
    expect(matrix.sendMessage).not.toHaveBeenCalled()
  })

  it('with whisperUrl POSTs WAV and sends transcribed text', async () => {
    const { plugin, matrix } = makePlugin('http://whisper:8080')
    await goToMessages(matrix, plugin)
    await plugin.startAudio()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: ' hello world ' }),
    }))
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: new Uint8Array([0x00, 0x00]) } })
    await plugin.stopAudio()
    expect(matrix.sendMessage).toHaveBeenCalledWith(DEFAULT_ROOM.id, 'hello world')
  })

  it('with whisperUrl but empty audioBuf does not POST to whisper', async () => {
    const { plugin, matrix } = makePlugin('http://whisper:8080')
    await goToMessages(matrix, plugin)
    await plugin.startAudio()
    // No audio events — audioBuf is empty
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    await plugin.stopAudio()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(matrix.sendMessage).not.toHaveBeenCalled()
  })

  it('shows transcribing view before whisper POST', async () => {
    const { bridge, plugin, matrix } = makePlugin('http://whisper:8080')
    await goToMessages(matrix, plugin)
    await plugin.startAudio()
    bridge.rebuildPageContainer.mockClear()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: async () => ({ text: 'hi' }),
    }))
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: new Uint8Array([0]) } })
    await plugin.stopAudio()
    const calls = bridge.rebuildPageContainer.mock.calls
    const transcribingCall = calls.find((c: any) => c[0].textObject?.[0]?.content === 'Transcribing...')
    expect(transcribingCall).toBeDefined()
  })

  it('shows sending view with transcribed text', async () => {
    const { bridge, plugin, matrix } = makePlugin('http://whisper:8080')
    await goToMessages(matrix, plugin)
    await plugin.startAudio()
    bridge.rebuildPageContainer.mockClear()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: async () => ({ text: 'hello there' }),
    }))
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: new Uint8Array([0]) } })
    await plugin.stopAudio()
    const calls = bridge.rebuildPageContainer.mock.calls
    const sendingCall = calls.find((c: any) => c[0].textObject?.[0]?.content?.startsWith('Sending:'))
    expect(sendingCall).toBeDefined()
  })

  it('SSE streaming: partial transcript updates glass text live', async () => {
    const { bridge, plugin, matrix } = makePlugin('http://whisper:8080')
    await goToMessages(matrix, plugin)
    await plugin.startAudio()
    const sseBody = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        controller.enqueue(enc.encode('data: {"text":"hello"}\n\n'))
        controller.enqueue(enc.encode('data: {"text":"hello world"}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: { get: (h: string) => h === 'content-type' ? 'text/event-stream' : null },
      body: sseBody,
    }))
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: new Uint8Array([0]) } })
    bridge.textContainerUpgrade.mockClear()
    await plugin.stopAudio()
    const upgrades = bridge.textContainerUpgrade.mock.calls
    expect(upgrades.some((c: any) => c[0].content === 'hello world')).toBe(true)
    expect(matrix.sendMessage).toHaveBeenCalledWith(DEFAULT_ROOM.id, 'hello world')
  })
})

// ─── Room hierarchy ───────────────────────────────────────────────────────────

describe('room hierarchy', () => {
  it('DMs section adds header at index 0 followed by DM rooms', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [{ id: 'dm-1', name: 'Alice' }], spaces: [], orphans: [] }, nextBatch: 'batch-0' })
    await plugin.start(null)
    const names = bridge.rebuildPageContainer.mock.calls[0][0].listObject[0].itemContainer.itemName
    expect(names[0]).toBe('── DMs ──')
    expect(names[1]).toBe('Alice')
  })

  it('space section adds space header and child rooms', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: {
      dms: [],
      spaces: [{ id: 'sp-1', name: 'ACME', rooms: [{ id: 'r-1', name: 'general' }] }],
      orphans: [],
    }, nextBatch: 'batch-0' })
    await plugin.start(null)
    const names = bridge.rebuildPageContainer.mock.calls[0][0].listObject[0].itemContainer.itemName
    expect(names[0]).toBe('── ACME ──')
    expect(names[1]).toBe('general')
  })

  it('orphans show without Other header when no DMs or spaces', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    await seedRooms(matrix, plugin, [{ id: 'r-1', name: 'Room' }])
    const names = bridge.rebuildPageContainer.mock.calls[0][0].listObject[0].itemContainer.itemName
    expect(names).toEqual(['Room'])
  })

  it('orphans get Other header when DMs are also present', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: {
      dms: [{ id: 'dm-1', name: 'Alice' }],
      spaces: [],
      orphans: [{ id: 'r-1', name: 'general' }],
    }, nextBatch: 'batch-0' })
    await plugin.start(null)
    const names = bridge.rebuildPageContainer.mock.calls[0][0].listObject[0].itemContainer.itemName
    expect(names).toEqual(['── DMs ──', 'Alice', '── Other ──', 'general'])
  })

  it('clicking a section header does not select a room', async () => {
    const { plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [{ id: 'dm-1', name: 'Alice' }], spaces: [], orphans: [] }, nextBatch: 'batch-0' })
    await plugin.start(null)
    // index 0 is the '── DMs ──' header
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    expect(plugin.getState().selectedRoomId).toBeNull()
    expect(matrix.fetchHistory).not.toHaveBeenCalled()
  })

  it('clicking a room after a header selects the correct room', async () => {
    const { plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [{ id: 'dm-1', name: 'Alice' }], spaces: [], orphans: [] }, nextBatch: 'batch-0' })
    await plugin.start(null)
    matrix.fetchHistory.mockResolvedValueOnce({ messages: [], prevBatch: null })
    // index 1 is 'Alice' (after the DMs header at index 0)
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 1 } })
    expect(plugin.getState().selectedRoomId).toBe('dm-1')
    expect(matrix.fetchHistory).toHaveBeenCalledWith('dm-1', 50, null, expect.any(AbortSignal))
  })
})

// ─── Rolling transcription ────────────────────────────────────────────────────

describe('rolling transcription', () => {
  const ENOUGH_BYTES = 32001

  it('fires after ROLLING_INTERVAL_MS and updates listening view with partial text', async () => {
    vi.useFakeTimers()
    const { bridge, plugin, matrix } = makePlugin('http://whisper:8080')
    await goToMessages(matrix, plugin)
    await plugin.startAudio()
    // Feed enough PCM to exceed ROLLING_MIN_BYTES
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: new Uint8Array(ENOUGH_BYTES) } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'partial text' }),
    }))
    bridge.textContainerUpgrade.mockClear()
    await vi.advanceTimersByTimeAsync(3001)
    const upgrades = bridge.textContainerUpgrade.mock.calls
    expect(upgrades.some((c: any) => c[0].content === 'partial text')).toBe(true)
    expect(plugin.getState().view).toBe('listening')
    vi.clearAllTimers()
    await plugin.stopAudio()
  })

  it('does not fire when audioBuf is below ROLLING_MIN_BYTES', async () => {
    vi.useFakeTimers()
    const { plugin, matrix } = makePlugin('http://whisper:8080')
    await goToMessages(matrix, plugin)
    await plugin.startAudio()
    // Tiny chunk — below threshold
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: new Uint8Array(100) } })
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    await vi.advanceTimersByTimeAsync(3001)
    expect(mockFetch).not.toHaveBeenCalled()
    vi.clearAllTimers()
    await plugin.stopAudio()
  })

  it('cancels in-flight rolling request on stopAudio', async () => {
    vi.useFakeTimers()
    const { plugin, matrix } = makePlugin('http://whisper:8080')
    await goToMessages(matrix, plugin)
    await plugin.startAudio()
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: new Uint8Array(ENOUGH_BYTES) } })
    let capturedSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce((_url: string, opts: RequestInit) => {
      capturedSignal = opts.signal as AbortSignal
      return new Promise(() => {}) // never resolves — simulates slow server
    }))
    // Trigger rolling call
    vi.advanceTimersByTime(3001)
    // Stop audio while rolling call is in-flight
    vi.useRealTimers()
    await plugin.stopAudio()
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('keeps view as listening during rolling (does not change to transcribing)', async () => {
    vi.useFakeTimers()
    const { plugin, matrix } = makePlugin('http://whisper:8080')
    await goToMessages(matrix, plugin)
    await plugin.startAudio()
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: new Uint8Array(ENOUGH_BYTES) } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'partial' }),
    }))
    await vi.advanceTimersByTimeAsync(3001)
    expect(plugin.getState().view).toBe('listening')
    vi.clearAllTimers()
    await plugin.stopAudio()
  })
})

// ─── Auto-follow behavior ─────────────────────────────────────────────────────

describe('auto-follow behavior', () => {
  it('entering a room shows messages view at bottom with scrollOffset 0', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    await seedRooms(matrix, plugin, [{ id: 'r1', name: 'Room' }])
    bridge.rebuildPageContainer.mockClear()
    matrix.fetchHistory.mockResolvedValueOnce({ messages: [{ event_id: 'ev1', sender: 'A', text: 'msg1', ts: 0 }], prevBatch: null })
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    expect(plugin.getState().view).toBe('messages')
    expect(plugin.getState().scrollOffset).toBe(0)
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(2) // loading indicator + messages view
  })

  it('new messages do not update display while scrolled into history', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(matrix, plugin, messages)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })
    expect(plugin.getState().scrollOffset).toBeGreaterThan(0)
    bridge.textContainerUpgrade.mockClear()
    await plugin.appendLine('new message')
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
  })

  it('new messages update display when at the top (offset 0)', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin)
    bridge.textContainerUpgrade.mockClear()
    await plugin.appendLine('new message')
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1)
  })
})

// ─── Feature 5: Connection health strip ──────────────────────────────────────

describe('connection health strip (feature 5)', () => {
  it('lastSyncAt is null before sync token callback fires', async () => {
    const { plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [], spaces: [], orphans: [] }, nextBatch: 'batch-0' })
    await plugin.start(null)
    expect(plugin.getState().lastSyncAt).toBeNull()
  })

  it('lastSyncAt is set to a number after sync token callback fires', async () => {
    const { plugin, matrix } = makePlugin()
    await plugin.start(null)
    matrix.triggerSyncToken('s_tok')
    expect(typeof plugin.getState().lastSyncAt).toBe('number')
    expect(plugin.getState().lastSyncAt).toBeGreaterThan(0)
  })

  it('whisperConfigured is false with no whisperUrl', async () => {
    const { plugin } = makePlugin(null)
    expect(plugin.getState().whisperConfigured).toBe(false)
  })

  it('whisperConfigured is true when whisperUrl is provided', async () => {
    const { plugin } = makePlugin('http://whisper:8080')
    expect(plugin.getState().whisperConfigured).toBe(true)
  })
})

// ─── Feature 6: Audio buffer gauge ───────────────────────────────────────────

describe('audio buffer gauge (feature 6)', () => {
  it('audioBufBytes reflects accumulated byte count after audio events', async () => {
    const { plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin)
    await plugin.startAudio()
    const chunk1 = new Uint8Array(100)
    const chunk2 = new Uint8Array(200)
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: chunk1 } })
    expect(plugin.getState().audioBufBytes).toBe(100)
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: chunk2 } })
    expect(plugin.getState().audioBufBytes).toBe(300)
  })
})

// ─── Feature 7: Per-room unread dot ──────────────────────────────────────────

describe('per-room unread dot (feature 7)', () => {
  it('sync message to non-selected room adds to unreadRooms', async () => {
    const { plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [], spaces: [], orphans: [{ id: 'room-1', name: 'Room1' }, { id: 'room-2', name: 'Room2' }] }, nextBatch: 'batch-0' })
    await plugin.start(null)
    matrix.fetchHistory.mockResolvedValueOnce({ messages: [], prevBatch: null })
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    expect(plugin.getState().selectedRoomId).toBe('room-1')
    await matrix.triggerSyncMessage('room-2', 'ev-x', 'Bob', 'hi')
    expect(plugin.getState().unreadRooms).toContain('room-2')
  })

  it('selecting a room removes it from unreadRooms', async () => {
    const { plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [], spaces: [], orphans: [{ id: 'room-1', name: 'Room1' }, { id: 'room-2', name: 'Room2' }] }, nextBatch: 'batch-0' })
    await plugin.start(null)
    matrix.fetchHistory.mockResolvedValueOnce({ messages: [], prevBatch: null })
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    await matrix.triggerSyncMessage('room-2', 'ev-x', 'Bob', 'hi')
    expect(plugin.getState().unreadRooms).toContain('room-2')
    matrix.fetchHistory.mockResolvedValueOnce({ messages: [], prevBatch: null })
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 1 } })
    expect(plugin.getState().unreadRooms).not.toContain('room-2')
  })

  it('sync message to currently selected room does NOT add to unreadRooms', async () => {
    const { plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [], spaces: [], orphans: [{ id: 'room-1', name: 'Room1' }] }, nextBatch: 'batch-0' })
    await plugin.start(null)
    matrix.fetchHistory.mockResolvedValueOnce({ messages: [], prevBatch: null })
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    expect(plugin.getState().selectedRoomId).toBe('room-1')
    await matrix.triggerSyncMessage('room-1', 'ev-y', 'Alice', 'hello')
    expect(plugin.getState().unreadRooms).not.toContain('room-1')
  })
})
