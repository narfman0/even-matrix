import { describe, it, expect, vi, afterEach } from 'vitest'
import { createPlugin } from './plugin'
import { makeMockBridge } from './__mocks__/bridge'
import { FakeWebSocket } from './__mocks__/websocket'

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

function makePlugin() {
  const bridge = makeMockBridge()
  const fakeWs = new FakeWebSocket()
  const MockWS = vi.fn().mockReturnValue(fakeWs)
  MockWS.OPEN = 1
  vi.stubGlobal('WebSocket', MockWS)
  const plugin = createPlugin(bridge, 'ws://localhost:4000/ws')
  return { bridge, plugin, ws: fakeWs, MockWS }
}

async function seedRooms(ws: FakeWebSocket, rooms: Array<{ id: string; name: string }>) {
  await ws.triggerMessage({ type: 'room_list', hierarchy: { dms: [], spaces: [], orphans: rooms } })
}

async function goToMessages(ws: FakeWebSocket, messages: Array<{ sender: string; text: string }> = []) {
  await ws.triggerMessage({ type: 'history', messages })
}

// ─── showRoomList ─────────────────────────────────────────────────────────────

describe('showRoomList', () => {
  it('renders rooms in the order received (backend sorts)', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await seedRooms(ws, [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }])
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.listObject[0].itemContainer.itemName).toEqual(['Alpha', 'Beta'])
  })

  it('shows all rooms without capping', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const rooms = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, name: `Room ${i}` }))
    await seedRooms(ws, rooms)
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.listObject[0].itemContainer.itemName).toHaveLength(25)
  })

  it('truncates room names to 64 chars', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await seedRooms(ws, [{ id: 'x', name: 'A'.repeat(70) }])
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.listObject[0].itemContainer.itemName[0]).toHaveLength(64)
  })

  it('sets view to rooms', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.showRoomList()
    expect(plugin.getState().view).toBe('rooms')
  })
})

// ─── showMessageView ──────────────────────────────────────────────────────────

describe('showMessageView', () => {
  it('shows all lines up to DISPLAY_MAX_LINES', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(ws, messages)
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    const lines = arg.textObject[0].content.split('\n')
    expect(lines).toHaveLength(10)
    expect(lines[0]).toBe('A: msg9')
    expect(lines[9]).toBe('A: msg0')
  })

  it('drops oldest lines when byte budget is exceeded', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const longMsg = 'x'.repeat(200)
    const messages = Array.from({ length: 8 }, (_, i) => ({ sender: 'A', text: `${i}:${longMsg}` }))
    await goToMessages(ws, messages)
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    const content = arg.textObject[0].content
    expect(content.length).toBeLessThanOrEqual(990)
    expect(content.startsWith(`A: 7:${longMsg}`)).toBe(true)
  })

  it('shows fallback when no messages', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws, [])
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.textObject[0].content).toBe('(no messages)')
  })

  it('sets view to messages', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
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
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
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
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const longMsg = 'x'.repeat(200)
    const messages = Array.from({ length: 6 }, (_, i) => ({ sender: 'A', text: `${i}:${longMsg}` }))
    await goToMessages(ws, messages)
    bridge.textContainerUpgrade.mockClear()
    await plugin.appendLine(`new:${longMsg}`)
    const arg = bridge.textContainerUpgrade.mock.calls[0][0]
    expect(arg.content.length).toBeLessThanOrEqual(990)
    expect(arg.content.startsWith(`new:${longMsg}`)).toBe(true)
  })
})

// ─── send ─────────────────────────────────────────────────────────────────────

describe('send', () => {
  it('serializes message as JSON when WebSocket is open', () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    plugin.send({ type: 'ping' })
    expect(ws.sent).toEqual(['{"type":"ping"}'])
  })

  it('does nothing when WebSocket readyState is not OPEN', () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    ws.readyState = 0
    plugin.send({ type: 'ping' })
    expect(ws.sent).toHaveLength(0)
  })

  it('does nothing before connect is called', () => {
    const { plugin, ws } = makePlugin()
    plugin.send({ type: 'ping' })
    expect(ws.sent).toHaveLength(0)
  })
})

// ─── WebSocket lifecycle ──────────────────────────────────────────────────────

describe('WebSocket onopen', () => {
  it('sends list_rooms when connection opens', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await ws.triggerOpen()
    expect(ws.sent).toContain('{"type":"list_rooms"}')
  })
})

describe('WebSocket onmessage', () => {
  it('room_list event calls showRoomList', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await seedRooms(ws, [{ id: '1', name: 'Room1' }])
    expect(bridge.rebuildPageContainer).toHaveBeenCalled()
  })

  it('history event formats lines as sender: text', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws, [{ sender: 'Alice', text: 'Hi' }])
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.textObject[0].content).toBe('Alice: Hi')
  })

  it('message event appends line when room matches', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await seedRooms(ws, [{ id: 'room-1', name: 'Room1' }])
    await plugin.handleEvenHubEvent({ listEvent: { eventType: 'CLICK', currentSelectItemIndex: 0 } })
    await ws.triggerMessage({ type: 'history', messages: [] })
    bridge.textContainerUpgrade.mockClear()
    await ws.triggerMessage({ type: 'message', room_id: 'room-1', sender: 'Bob', text: 'Hey' })
    expect(bridge.textContainerUpgrade).toHaveBeenCalled()
  })

  it('message event ignores different room', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await seedRooms(ws, [{ id: 'room-1', name: 'Room1' }])
    await plugin.handleEvenHubEvent({ listEvent: { eventType: 'CLICK', currentSelectItemIndex: 0 } })
    await ws.triggerMessage({ type: 'history', messages: [] })
    bridge.textContainerUpgrade.mockClear()
    await ws.triggerMessage({ type: 'message', room_id: 'room-2', sender: 'Eve', text: 'X' })
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
  })

  it('status events are ignored', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    bridge.textContainerUpgrade.mockClear()
    await ws.triggerMessage({ type: 'status', text: 'Heard: hello world' })
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
    expect(plugin.getState().lines).not.toContain('Heard: hello world')
  })

  it('schedules reconnect 3s after close', () => {
    vi.useFakeTimers()
    const { plugin, ws, MockWS } = makePlugin()
    plugin.connect()
    expect(MockWS).toHaveBeenCalledTimes(1)
    ws.triggerClose()
    vi.advanceTimersByTime(3000)
    expect(MockWS).toHaveBeenCalledTimes(2)
  })
})

// ─── EvenHub event handler ────────────────────────────────────────────────────

describe('handleEvenHubEvent', () => {
  it('list click selects room and sends select_room', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await seedRooms(ws, [{ id: 'a-id', name: 'Alpha' }, { id: 'b-id', name: 'Beta' }])
    ws.sent = []
    await plugin.handleEvenHubEvent({ listEvent: { eventType: 'CLICK', currentSelectItemIndex: 1 } })
    expect(plugin.getState().selectedRoomId).toBe('b-id')
    expect(ws.sent).toContain(JSON.stringify({ type: 'select_room', room_id: 'b-id' }))
  })

  it('list scroll does not select room', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await seedRooms(ws, [{ id: 'a', name: 'Alpha' }])
    ws.sent = []
    await plugin.handleEvenHubEvent({ listEvent: { eventType: 'SCROLL_TOP', currentSelectItemIndex: 0 } })
    expect(plugin.getState().selectedRoomId).toBeNull()
    expect(ws.sent).toHaveLength(0)
  })

  it('double click in messages view starts audio and shows listening screen', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
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
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
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
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
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
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    bridge.rebuildPageContainer.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: undefined } })
    expect(bridge.rebuildPageContainer).toHaveBeenCalled()
    expect(plugin.getState().view).toBe('rooms')
  })

  it('back gesture in listening view stops audio and returns to messages', async () => {
    vi.useFakeTimers()
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
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
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(ws, messages)
    bridge.textContainerUpgrade.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })
    expect(plugin.getState().scrollOffset).toBe(3)
    const content = bridge.textContainerUpgrade.mock.calls[0][0].content
    expect(content).toContain('A: msg0')
    expect(content).not.toContain('A: msg9')
  })

  it('scroll up returns to latest messages', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(ws, messages)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })
    bridge.textContainerUpgrade.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_TOP' } })
    expect(plugin.getState().scrollOffset).toBe(0)
    const content = bridge.textContainerUpgrade.mock.calls[0][0].content
    expect(content).toContain('A: msg9')
  })

  it('scroll offset does not go below zero', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_TOP' } })
    expect(plugin.getState().scrollOffset).toBe(0)
  })

  it('new messages do not update display while scrolled into history', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(ws, messages)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })
    expect(plugin.getState().scrollOffset).toBeGreaterThan(0)
    bridge.textContainerUpgrade.mockClear()
    await plugin.appendLine('new message')
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
  })

  it('new messages update display when at the top (offset 0)', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    bridge.textContainerUpgrade.mockClear()
    await plugin.appendLine('new message')
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1)
  })

  it('entering a room resets scroll offset to 0', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(ws, messages)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })
    expect(plugin.getState().scrollOffset).toBe(3)
    await plugin.showMessageView([])
    expect(plugin.getState().scrollOffset).toBe(0)
  })

  it('audioEvent forwards PCM bytes', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    ws.sentBinary = []
    const pcm = new Uint8Array([0x00, 0x01, 0x02, 0x03])
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: pcm } })
    expect(ws.sentBinary).toHaveLength(1)
    expect(ws.sentBinary[0]).toEqual(pcm)
  })

  it('audioEvent does nothing when WebSocket is not open', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    ws.readyState = 0
    ws.sentBinary = []
    const pcm = new Uint8Array([0x00, 0x01])
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: pcm } })
    expect(ws.sentBinary).toHaveLength(0)
  })
})

// ─── startAudio / stopAudio ───────────────────────────────────────────────────

describe('startAudio', () => {
  it('opens mic and sets recognizing immediately', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    expect(bridge.audioControl).toHaveBeenCalledWith(true)
    expect(plugin.getState().recognizing).toBe(true)
  })

  it('shows listening screen and sets view immediately', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    bridge.rebuildPageContainer.mockClear()
    await plugin.startAudio()
    expect(plugin.getState().view).toBe('listening')
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.textObject[0].content).toBe('Listening...')
  })

  it('sends audio_start immediately on startAudio', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    ws.sent = []
    await plugin.startAudio()
    expect(ws.sent).toContain(JSON.stringify({ type: 'audio_start' }))
    expect(plugin.getState().lines).not.toContain('Listening...')
  })
})

describe('stopAudio', () => {
  it('turns off mic and clears recognizing', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    bridge.audioControl.mockClear()
    await plugin.stopAudio()
    expect(bridge.audioControl).toHaveBeenCalledWith(false)
    expect(plugin.getState().recognizing).toBe(false)
  })

  it('sends audio_end', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    ws.sent = []
    await plugin.stopAudio()
    expect(ws.sent).toContain(JSON.stringify({ type: 'audio_end' }))
  })

  it('re-renders messages view at bottom so user lands back in the room', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws, [{ sender: 'Alice', text: 'Hi' }])
    await plugin.startAudio()
    bridge.rebuildPageContainer.mockClear()
    await plugin.stopAudio()
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce()
    expect(plugin.getState().view).toBe('messages')
    expect(plugin.getState().scrollOffset).toBe(0)
  })
})

// ─── Room hierarchy ───────────────────────────────────────────────────────────

describe('room hierarchy', () => {
  it('DMs section adds header at index 0 followed by DM rooms', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await ws.triggerMessage({
      type: 'room_list',
      hierarchy: { dms: [{ id: 'dm-1', name: 'Alice' }], spaces: [], orphans: [] },
    })
    const names = bridge.rebuildPageContainer.mock.calls[0][0].listObject[0].itemContainer.itemName
    expect(names[0]).toBe('── DMs ──')
    expect(names[1]).toBe('Alice')
  })

  it('space section adds space header and child rooms', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await ws.triggerMessage({
      type: 'room_list',
      hierarchy: {
        dms: [],
        spaces: [{ id: 'sp-1', name: 'ACME', rooms: [{ id: 'r-1', name: 'general' }] }],
        orphans: [],
      },
    })
    const names = bridge.rebuildPageContainer.mock.calls[0][0].listObject[0].itemContainer.itemName
    expect(names[0]).toBe('── ACME ──')
    expect(names[1]).toBe('general')
  })

  it('orphans show without Other header when no DMs or spaces', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await seedRooms(ws, [{ id: 'r-1', name: 'Room' }])
    const names = bridge.rebuildPageContainer.mock.calls[0][0].listObject[0].itemContainer.itemName
    expect(names).toEqual(['Room'])
  })

  it('orphans get Other header when DMs are also present', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await ws.triggerMessage({
      type: 'room_list',
      hierarchy: {
        dms: [{ id: 'dm-1', name: 'Alice' }],
        spaces: [],
        orphans: [{ id: 'r-1', name: 'general' }],
      },
    })
    const names = bridge.rebuildPageContainer.mock.calls[0][0].listObject[0].itemContainer.itemName
    expect(names).toEqual(['── DMs ──', 'Alice', '── Other ──', 'general'])
  })

  it('clicking a section header does not select a room', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await ws.triggerMessage({
      type: 'room_list',
      hierarchy: { dms: [{ id: 'dm-1', name: 'Alice' }], spaces: [], orphans: [] },
    })
    ws.sent = []
    // index 0 is the '── DMs ──' header
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 0 } })
    expect(plugin.getState().selectedRoomId).toBeNull()
    expect(ws.sent).toHaveLength(0)
  })

  it('clicking a room after a header selects the correct room', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await ws.triggerMessage({
      type: 'room_list',
      hierarchy: { dms: [{ id: 'dm-1', name: 'Alice' }], spaces: [], orphans: [] },
    })
    ws.sent = []
    // index 1 is 'Alice' (after the DMs header at index 0)
    await plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: 1 } })
    expect(plugin.getState().selectedRoomId).toBe('dm-1')
    expect(ws.sent).toContain(JSON.stringify({ type: 'select_room', room_id: 'dm-1' }))
  })
})

// ─── Auto-follow behavior ─────────────────────────────────────────────────────

describe('auto-follow behavior', () => {
  it('first history enters room at bottom with scrollOffset 0', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    // Start from rooms view
    await seedRooms(ws, [{ id: 'r1', name: 'Room' }])
    bridge.rebuildPageContainer.mockClear()
    await goToMessages(ws, [{ sender: 'A', text: 'msg1' }])
    expect(plugin.getState().view).toBe('messages')
    expect(plugin.getState().scrollOffset).toBe(0)
    // Full rebuild was called (not just upgrade)
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce()
  })

  it('second history at bottom updates display via textContainerUpgrade only', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws, [{ sender: 'A', text: 'first' }])
    bridge.rebuildPageContainer.mockClear()
    bridge.textContainerUpgrade.mockClear()
    // Second history arrives while already in messages view at offset 0
    await ws.triggerMessage({ type: 'history', messages: [{ sender: 'A', text: 'first' }, { sender: 'A', text: 'second' }] })
    expect(bridge.rebuildPageContainer).not.toHaveBeenCalled()
    expect(bridge.textContainerUpgrade).toHaveBeenCalledOnce()
    expect(plugin.getState().lines).toContain('A: second')
  })

  it('second history while scrolled into history updates lines silently without touching display', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(ws, messages)
    // Scroll down into history
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })
    expect(plugin.getState().scrollOffset).toBeGreaterThan(0)
    bridge.rebuildPageContainer.mockClear()
    bridge.textContainerUpgrade.mockClear()
    // Second history arrives while scrolled up
    const more = [...messages, { sender: 'A', text: 'new' }]
    await ws.triggerMessage({ type: 'history', messages: more })
    expect(bridge.rebuildPageContainer).not.toHaveBeenCalled()
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
    expect(plugin.getState().lines).toContain('A: new')
    expect(plugin.getState().scrollOffset).toBeGreaterThan(0)
  })

  it('scrolling back to latest after history-while-scrolled shows refreshed lines', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(ws, messages)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })
    const more = [...messages, { sender: 'A', text: 'latest' }]
    await ws.triggerMessage({ type: 'history', messages: more })
    bridge.textContainerUpgrade.mockClear()
    // Scroll back up to offset 0 (latest)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_TOP' } })
    expect(plugin.getState().scrollOffset).toBe(0)
    const content = bridge.textContainerUpgrade.mock.calls[0][0].content
    expect(content).toContain('A: latest')
  })
})

