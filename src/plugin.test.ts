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
  matrix.fetchHistory.mockResolvedValueOnce(
    messages.map((m, i) => ({ event_id: `ev-${i}`, sender: m.sender, text: m.text, ts: 0 }))
  )
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
  it('shows all lines up to DISPLAY_MAX_LINES', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(matrix, plugin, messages)
    const arg = bridge.rebuildPageContainer.mock.calls.at(-1)![0]
    const lines = arg.textObject[0].content.split('\n')
    expect(lines).toHaveLength(10)
    expect(lines[0]).toBe('A: msg9')
    expect(lines[9]).toBe('A: msg0')
  })

  it('drops oldest lines when byte budget is exceeded', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    const longMsg = 'x'.repeat(200)
    const messages = Array.from({ length: 8 }, (_, i) => ({ sender: 'A', text: `${i}:${longMsg}` }))
    await goToMessages(matrix, plugin, messages)
    const arg = bridge.rebuildPageContainer.mock.calls.at(-1)![0]
    const content = arg.textObject[0].content
    expect(content.length).toBeLessThanOrEqual(990)
    expect(content.startsWith(`A: 7:${longMsg}`)).toBe(true)
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
    expect(arg.content.length).toBeLessThanOrEqual(990)
    expect(arg.content.startsWith(`new:${longMsg}`)).toBe(true)
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
    matrix.fetchHistory.mockResolvedValueOnce([])
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    bridge.textContainerUpgrade.mockClear()
    await matrix.triggerSyncMessage('room-1', 'ev-new', 'Bob', 'Hey')
    expect(bridge.textContainerUpgrade).toHaveBeenCalled()
  })

  it('ignores message when room does not match', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [], spaces: [], orphans: [{ id: 'room-1', name: 'Room1' }] }, nextBatch: 'batch-0' })
    await plugin.start(null)
    matrix.fetchHistory.mockResolvedValueOnce([])
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    bridge.textContainerUpgrade.mockClear()
    await matrix.triggerSyncMessage('room-2', 'ev-new', 'Eve', 'X')
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
  })

  it('deduplicates messages by event_id', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    matrix.initialSync.mockResolvedValueOnce({ hierarchy: { dms: [], spaces: [], orphans: [{ id: 'room-1', name: 'Room1' }] }, nextBatch: 'batch-0' })
    await plugin.start(null)
    matrix.fetchHistory.mockResolvedValueOnce([{ event_id: 'ev-1', sender: 'Alice', text: 'Hi', ts: 0 }])
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
    matrix.fetchHistory.mockResolvedValueOnce([{ event_id: 'ev1', sender: 'Alice', text: 'Hi', ts: 0 }])
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    expect(matrix.fetchHistory).toHaveBeenCalledWith('r1', 50, expect.any(AbortSignal))
    const arg = bridge.rebuildPageContainer.mock.calls.at(-1)![0]
    expect(arg.textObject[0].content).toBe('Alice: Hi')
  })

  it('sets selectedRoomId', async () => {
    const { plugin, matrix } = makePlugin()
    await seedRooms(matrix, plugin, [{ id: 'room-a', name: 'Alpha' }, { id: 'room-b', name: 'Beta' }])
    matrix.fetchHistory.mockResolvedValueOnce([])
    await plugin.handleEvenHubEvent({ listEvent: { eventType: 'CLICK', currentSelectItemIndex: 1 } })
    expect(plugin.getState().selectedRoomId).toBe('room-b')
    expect(matrix.fetchHistory).toHaveBeenCalledWith('room-b', 50, expect.any(AbortSignal))
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
    const { bridge, plugin, matrix } = makePlugin()
    await goToMessages(matrix, plugin)
    bridge.rebuildPageContainer.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    expect(bridge.audioControl).toHaveBeenCalledWith(true)
    expect(plugin.getState().recognizing).toBe(true)
    expect(plugin.getState().view).toBe('listening')
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.textObject[0].content).toBe('Listening...')
  })

  it('tap in listening view stops audio after cooldown', async () => {
    vi.useFakeTimers()
    const { bridge, plugin, matrix } = makePlugin()
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
    const { bridge, plugin, matrix } = makePlugin()
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
    const { bridge, plugin, matrix } = makePlugin()
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
    expect(content).toContain('A: msg0')
    expect(content).not.toContain('A: msg9')
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
    expect(content).toContain('A: msg9')
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
    matrix.fetchHistory.mockResolvedValueOnce([])
    // index 1 is 'Alice' (after the DMs header at index 0)
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 1 } })
    expect(plugin.getState().selectedRoomId).toBe('dm-1')
    expect(matrix.fetchHistory).toHaveBeenCalledWith('dm-1', 50, expect.any(AbortSignal))
  })
})

// ─── Auto-follow behavior ─────────────────────────────────────────────────────

describe('auto-follow behavior', () => {
  it('entering a room shows messages view at bottom with scrollOffset 0', async () => {
    const { bridge, plugin, matrix } = makePlugin()
    await seedRooms(matrix, plugin, [{ id: 'r1', name: 'Room' }])
    bridge.rebuildPageContainer.mockClear()
    matrix.fetchHistory.mockResolvedValueOnce([{ event_id: 'ev1', sender: 'A', text: 'msg1', ts: 0 }])
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
