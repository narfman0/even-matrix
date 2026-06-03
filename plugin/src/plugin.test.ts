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
  await ws.triggerMessage({ type: 'room_list', rooms })
}

async function goToMessages(ws: FakeWebSocket, messages: Array<{ sender: string; text: string }> = []) {
  await ws.triggerMessage({ type: 'history', messages })
}

// ─── showRoomList ─────────────────────────────────────────────────────────────

describe('showRoomList', () => {
  it('sorts rooms alphabetically', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await seedRooms(ws, [{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Alpha' }])
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.listObject[0].itemContainer.itemName).toEqual(['Alpha', 'Beta'])
  })

  it('caps list at 20 rooms', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const rooms = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, name: `Room ${i}` }))
    await seedRooms(ws, rooms)
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.listObject[0].itemContainer.itemName).toHaveLength(20)
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
  it('shows last 8 of more than 8 lines', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(ws, messages)
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    const lines = arg.textObject[0].content.split('\n')
    expect(lines).toHaveLength(8)
    expect(lines[0]).toBe('A: msg2')
    expect(lines[7]).toBe('A: msg9')
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

  it('limits upgrade content to last 8 lines', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const messages = Array.from({ length: 8 }, (_, i) => ({ sender: 'A', text: `${i}` }))
    await goToMessages(ws, messages)
    bridge.textContainerUpgrade.mockClear()
    await plugin.appendLine('new')
    const arg = bridge.textContainerUpgrade.mock.calls[0][0]
    const lines = arg.content.split('\n')
    expect(lines).toHaveLength(8)
    expect(lines[0]).toBe('A: 1')
    expect(lines[7]).toBe('new')
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

  it('status event appends line in messages view', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    bridge.textContainerUpgrade.mockClear()
    await ws.triggerMessage({ type: 'status', text: 'Connected' })
    expect(bridge.textContainerUpgrade).toHaveBeenCalled()
  })

  it('status event ignored in rooms view', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await ws.triggerMessage({ type: 'status', text: 'Connected' })
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
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

  it('double click in messages view starts audio capture', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    ws.sent = []
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    expect(bridge.audioControl).toHaveBeenCalledWith(true)
    expect(ws.sent).toContain(JSON.stringify({ type: 'audio_start' }))
    expect(plugin.getState().recognizing).toBe(true)
  })

  it('tap while recognizing stops audio', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    bridge.audioControl.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'CLICK' } })
    expect(bridge.audioControl).toHaveBeenCalledWith(false)
    expect(plugin.getState().recognizing).toBe(false)
  })

  it('double tap while recognizing stops audio instead of starting new', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    bridge.audioControl.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    expect(bridge.audioControl).toHaveBeenCalledWith(false)
    expect(bridge.audioControl).not.toHaveBeenCalledWith(true)
  })

  it('back gesture (undefined sysEvent type) shows room list', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    bridge.rebuildPageContainer.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: undefined } })
    expect(bridge.rebuildPageContainer).toHaveBeenCalled()
    expect(plugin.getState().view).toBe('rooms')
  })

  it('sysEvent ignored when view is rooms', async () => {
    const { bridge, plugin } = makePlugin()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: undefined } })
    expect(bridge.rebuildPageContainer).not.toHaveBeenCalled()
  })

  it('audioEvent forwards PCM bytes as binary WebSocket frame', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    const pcm = new Uint8Array([0x00, 0x01, 0x02, 0x03])
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: pcm } })
    expect(ws.sentBinary).toHaveLength(1)
    expect(ws.sentBinary[0]).toEqual(pcm)
  })

  it('audioEvent does nothing when WebSocket is not open', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    ws.readyState = 0
    const pcm = new Uint8Array([0x00, 0x01])
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: pcm } })
    expect(ws.sentBinary).toHaveLength(0)
  })
})

// ─── startAudio / stopAudio ───────────────────────────────────────────────────

describe('startAudio', () => {
  it('sends audio_start and calls audioControl(true)', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    ws.sent = []
    await plugin.startAudio()
    expect(ws.sent).toContain(JSON.stringify({ type: 'audio_start' }))
    expect(bridge.audioControl).toHaveBeenCalledWith(true)
  })

  it('sets recognizing to true', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    expect(plugin.getState().recognizing).toBe(true)
  })

  it('appends Listening... to the display', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    expect(plugin.getState().lines).toContain('Listening...')
  })

  it('auto-stops after timeout sending audio_end', async () => {
    vi.useFakeTimers()
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    ws.sent = []
    await plugin.startAudio()
    await vi.runAllTimersAsync()
    expect(bridge.audioControl).toHaveBeenCalledWith(false)
    expect(ws.sent).toContain(JSON.stringify({ type: 'audio_end' }))
    expect(plugin.getState().recognizing).toBe(false)
  })

  it('auto-stop is skipped if already stopped before timeout', async () => {
    vi.useFakeTimers()
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    await plugin.stopAudio()
    bridge.audioControl.mockClear()
    await vi.runAllTimersAsync()
    expect(bridge.audioControl).not.toHaveBeenCalled()
  })
})

describe('stopAudio', () => {
  it('calls audioControl(false) and sends audio_end', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    ws.sent = []
    await plugin.stopAudio()
    expect(bridge.audioControl).toHaveBeenCalledWith(false)
    expect(ws.sent).toContain(JSON.stringify({ type: 'audio_end' }))
  })

  it('sets recognizing to false', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    await plugin.stopAudio()
    expect(plugin.getState().recognizing).toBe(false)
  })
})
