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

// PCM helpers — 16 kHz s16le mono

/** Silent PCM: enough samples to finish calibration (4 000 samples = 8 000 bytes). */
function calibPcm(): Uint8Array {
  return new Uint8Array(4_000 * 2)
}

/** PCM chunk with constant amplitude; RMS = amplitude / 32768. */
function pcmChunk(samples: number, amplitude: number): Uint8Array {
  const buf = new Uint8Array(samples * 2)
  const view = new DataView(buf.buffer)
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, amplitude, true)
  return buf
}

/** Complete calibration with a silent baseline (ambient RMS ≈ 0, threshold = 0.01). */
async function completeCalibration(plugin: ReturnType<typeof createPlugin>) {
  await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: calibPcm() } })
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
  it('shows all lines up to DISPLAY_MAX_LINES', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(ws, messages)
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    const lines = arg.textObject[0].content.split('\n')
    expect(lines).toHaveLength(10)
    expect(lines[0]).toBe('A: msg0')
    expect(lines[9]).toBe('A: msg9')
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
    expect(content.endsWith(`A: 7:${longMsg}`)).toBe(true)
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
    expect(arg.content.endsWith(`new:${longMsg}`)).toBe(true)
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
    expect(plugin.getState().calibrating).toBe(true)
    expect(plugin.getState().view).toBe('listening')
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.textObject[0].content).toBe('Listening...')
  })

  it('tap in listening view stops audio', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    expect(plugin.getState().view).toBe('listening')
    bridge.audioControl.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'CLICK' } })
    expect(bridge.audioControl).toHaveBeenCalledWith(false)
    expect(plugin.getState().recognizing).toBe(false)
    expect(plugin.getState().view).toBe('messages')
  })

  it('double tap in listening view stops audio instead of starting new', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    bridge.audioControl.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    expect(bridge.audioControl).toHaveBeenCalledWith(false)
    expect(bridge.audioControl).not.toHaveBeenCalledWith(true)
  })

  it('back gesture (undefined sysEvent type) shows room list when not recording', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    bridge.rebuildPageContainer.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: undefined } })
    expect(bridge.rebuildPageContainer).toHaveBeenCalled()
    expect(plugin.getState().view).toBe('rooms')
  })

  it('back gesture in listening view stops audio and returns to messages', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } })
    expect(plugin.getState().view).toBe('listening')
    bridge.audioControl.mockClear()
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

  it('scroll up increases offset and shows older messages', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(ws, messages)
    bridge.textContainerUpgrade.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_TOP' } })
    expect(plugin.getState().scrollOffset).toBe(3)
    const content = bridge.textContainerUpgrade.mock.calls[0][0].content
    expect(content).toContain('A: msg0')
    expect(content).not.toContain('A: msg9')
  })

  it('scroll down decreases offset back toward latest messages', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(ws, messages)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_TOP' } })
    bridge.textContainerUpgrade.mockClear()
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })
    expect(plugin.getState().scrollOffset).toBe(0)
    const content = bridge.textContainerUpgrade.mock.calls[0][0].content
    expect(content).toContain('A: msg9')
  })

  it('scroll offset does not go below zero', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })
    expect(plugin.getState().scrollOffset).toBe(0)
  })

  it('new messages do not update display while scrolled back', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(ws, messages)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_TOP' } })
    expect(plugin.getState().scrollOffset).toBeGreaterThan(0)
    bridge.textContainerUpgrade.mockClear()
    await plugin.appendLine('new message')
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
  })

  it('new messages update display when at the bottom (offset 0)', async () => {
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
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_TOP' } })
    expect(plugin.getState().scrollOffset).toBe(3)
    await plugin.showMessageView([])
    expect(plugin.getState().scrollOffset).toBe(0)
  })

  it('audioEvent forwards PCM bytes after calibration', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    await completeCalibration(plugin)
    ws.sentBinary = []
    const pcm = new Uint8Array([0x00, 0x01, 0x02, 0x03])
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: pcm } })
    expect(ws.sentBinary).toHaveLength(1)
    expect(ws.sentBinary[0]).toEqual(pcm)
  })

  it('audioEvent does not forward PCM during calibration', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    const pcm = new Uint8Array(100)
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: pcm } })
    expect(ws.sentBinary).toHaveLength(0)
  })

  it('audioEvent does nothing when WebSocket is not open', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    await completeCalibration(plugin)
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
    expect(plugin.getState().calibrating).toBe(true)
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

  it('does not send audio_start before calibration', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    ws.sent = []
    await plugin.startAudio()
    expect(ws.sent).not.toContain(JSON.stringify({ type: 'audio_start' }))
    expect(plugin.getState().lines).not.toContain('Listening...')
  })

  it('sends audio_start after calibration without adding to lines', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    ws.sent = []
    await plugin.startAudio()
    await completeCalibration(plugin)
    expect(ws.sent).toContain(JSON.stringify({ type: 'audio_start' }))
    expect(plugin.getState().lines).not.toContain('Listening...')
    expect(plugin.getState().calibrating).toBe(false)
  })

  it('calibration accumulates across multiple small chunks', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    ws.sent = []
    await plugin.startAudio()
    // Send 4 chunks of 1000 samples each = 4000 total
    const chunk = new Uint8Array(1_000 * 2)
    for (let i = 0; i < 4; i++) {
      await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: chunk } })
    }
    expect(ws.sent).toContain(JSON.stringify({ type: 'audio_start' }))
  })

  it('computes ambient RMS from calibration audio', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    // Calibrate with amplitude 3276 → RMS ≈ 0.1
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: pcmChunk(4_000, 3276) } })
    expect(plugin.getState().ambientRms).toBeCloseTo(0.1, 2)
  })

  it('auto-stops after timeout', async () => {
    vi.useFakeTimers()
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    await completeCalibration(plugin)
    await vi.runAllTimersAsync()
    expect(bridge.audioControl).toHaveBeenCalledWith(false)
    expect(plugin.getState().recognizing).toBe(false)
  })

  it('auto-stop sends audio_end after calibration', async () => {
    vi.useFakeTimers()
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    await completeCalibration(plugin)
    ws.sent = []
    await vi.runAllTimersAsync()
    expect(ws.sent).toContain(JSON.stringify({ type: 'audio_end' }))
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

  it('sends audio_end when calibration completed', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    await completeCalibration(plugin)
    ws.sent = []
    await plugin.stopAudio()
    expect(ws.sent).toContain(JSON.stringify({ type: 'audio_end' }))
  })

  it('does not send audio_end when stopped before calibration', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    ws.sent = []
    await plugin.stopAudio()
    expect(ws.sent).not.toContain(JSON.stringify({ type: 'audio_end' }))
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

// ─── Silence detection ────────────────────────────────────────────────────────

describe('silence detection', () => {
  it('stops recording after sustained silence', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    await completeCalibration(plugin)  // ambient = 0, threshold = 0.01
    // 24 000 silent samples triggers auto-stop
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: new Uint8Array(24_000 * 2) } })
    expect(plugin.getState().recognizing).toBe(false)
    expect(bridge.audioControl).toHaveBeenCalledWith(false)
  })

  it('does not stop during speech above threshold', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    await completeCalibration(plugin)
    // amplitude 1000 → RMS ≈ 0.030 > threshold 0.01
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: pcmChunk(24_000, 1_000) } })
    expect(plugin.getState().recognizing).toBe(true)
  })

  it('resets silence counter when speech is detected', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    await completeCalibration(plugin)
    // 12 000 silent samples (half the threshold)
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: new Uint8Array(12_000 * 2) } })
    expect(plugin.getState().recognizing).toBe(true)
    // Speech resets counter
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: pcmChunk(160, 1_000) } })
    // 12 000 more silent samples — should not stop (counter was reset)
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: new Uint8Array(12_000 * 2) } })
    expect(plugin.getState().recognizing).toBe(true)
  })

  it('silence threshold scales with ambient RMS', async () => {
    const { plugin, ws } = makePlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    // Calibrate with amplitude 1638 → RMS ≈ 0.05, threshold = max(0.01, 0.10) = 0.10
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: pcmChunk(4_000, 1_638) } })
    // amplitude 1000 → RMS ≈ 0.030 — below threshold of 0.10, counts as silence
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: pcmChunk(24_000, 1_000) } })
    expect(plugin.getState().recognizing).toBe(false)
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

  it('second history while scrolled up updates lines silently without touching display', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(ws, messages)
    // Scroll up
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_TOP' } })
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

  it('scrolling back to bottom after second-history-while-scrolled shows refreshed lines', async () => {
    const { bridge, plugin, ws } = makePlugin()
    plugin.connect()
    const messages = Array.from({ length: 10 }, (_, i) => ({ sender: 'A', text: `msg${i}` }))
    await goToMessages(ws, messages)
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_TOP' } })
    const more = [...messages, { sender: 'A', text: 'latest' }]
    await ws.triggerMessage({ type: 'history', messages: more })
    bridge.textContainerUpgrade.mockClear()
    // Scroll all the way back down to offset 0
    await plugin.handleEvenHubEvent({ sysEvent: { eventType: 'SCROLL_BOTTOM' } })
    expect(plugin.getState().scrollOffset).toBe(0)
    const content = bridge.textContainerUpgrade.mock.calls[0][0].content
    expect(content).toContain('A: latest')
  })
})

// ─── Simulator STT path ───────────────────────────────────────────────────────

function makeSimulatorPlugin() {
  const recognition = {
    start: vi.fn(),
    stop: vi.fn(),
    onresult: null as any,
    onend: null as any,
    onerror: null as any,
    continuous: false,
    interimResults: false,
    lang: '',
  }
  vi.stubGlobal('SpeechRecognition', vi.fn(() => recognition))
  const { bridge, plugin, ws } = makePlugin()
  return { bridge, plugin, ws, recognition }
}

describe('simulator STT path', () => {
  it('startAudio shows listening screen without calling audioControl', async () => {
    const { bridge, plugin, ws } = makeSimulatorPlugin()
    plugin.connect()
    await goToMessages(ws)
    bridge.rebuildPageContainer.mockClear()
    await plugin.startAudio()
    expect(bridge.audioControl).not.toHaveBeenCalled()
    expect(plugin.getState().view).toBe('listening')
    const arg = bridge.rebuildPageContainer.mock.calls[0][0]
    expect(arg.textObject[0].content).toBe('Listening...')
  })

  it('startAudio calls recognition.start()', async () => {
    const { plugin, ws, recognition } = makeSimulatorPlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    expect(recognition.start).toHaveBeenCalledOnce()
  })

  it('onresult sends transcript and stops audio', async () => {
    const { bridge, plugin, ws, recognition } = makeSimulatorPlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    ws.sent = []
    await recognition.onresult({ results: [[{ transcript: 'hello world' }]] })
    expect(ws.sent).toContain(JSON.stringify({ type: 'transcript', text: 'hello world' }))
    expect(plugin.getState().recognizing).toBe(false)
    expect(plugin.getState().view).toBe('messages')
  })

  it('stopAudio calls recognition.stop() and returns to messages', async () => {
    const { bridge, plugin, ws, recognition } = makeSimulatorPlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    bridge.rebuildPageContainer.mockClear()
    await plugin.stopAudio()
    expect(recognition.stop).toHaveBeenCalledOnce()
    expect(bridge.audioControl).not.toHaveBeenCalled()
    expect(plugin.getState().view).toBe('messages')
  })

  it('stopAudio does not send audio_end', async () => {
    const { plugin, ws, recognition } = makeSimulatorPlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    ws.sent = []
    await plugin.stopAudio()
    expect(ws.sent).not.toContain(JSON.stringify({ type: 'audio_end' }))
  })

  it('onend calls stopAudio while recognizing', async () => {
    const { plugin, ws, recognition } = makeSimulatorPlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    await recognition.onend()
    expect(plugin.getState().recognizing).toBe(false)
    expect(plugin.getState().view).toBe('messages')
  })

  it('onerror calls stopAudio while recognizing', async () => {
    const { plugin, ws, recognition } = makeSimulatorPlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    await recognition.onerror()
    expect(plugin.getState().recognizing).toBe(false)
    expect(plugin.getState().view).toBe('messages')
  })

  it('timeout auto-stops and calls recognition.stop()', async () => {
    vi.useFakeTimers()
    const { plugin, ws, recognition } = makeSimulatorPlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    await vi.runAllTimersAsync()
    expect(recognition.stop).toHaveBeenCalled()
    expect(plugin.getState().recognizing).toBe(false)
  })

  it('audioEvent PCM is ignored in simulator path', async () => {
    const { plugin, ws, recognition } = makeSimulatorPlugin()
    plugin.connect()
    await goToMessages(ws)
    await plugin.startAudio()
    const pcm = new Uint8Array(4_000 * 2)
    await plugin.handleEvenHubEvent({ audioEvent: { audioPcm: pcm } })
    // PCM ignored — recognition.start was already called, no audio_start sent
    expect(ws.sent).not.toContain(JSON.stringify({ type: 'audio_start' }))
    expect(plugin.getState().calibrating).toBe(false)
  })
})
