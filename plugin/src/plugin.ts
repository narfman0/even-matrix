import {
  TextContainerProperty,
  TextContainerUpgrade,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

const CONTAINER_ID = 1

export interface Bridge {
  rebuildPageContainer(c: any): Promise<any>
  textContainerUpgrade(c: any): Promise<any>
  audioControl(open: boolean): Promise<boolean>
}

const DISPLAY_MAX_LINES = 20
const DISPLAY_MAX_BYTES = 990
const SCROLL_STEP = 3

const MAX_ERRORS = 50

function log(level: 'info' | 'warn' | 'error', msg: string, data?: any) {
  const prefix = `[even-matrix] [${level.toUpperCase()}]`
  if (data !== undefined) {
    console[level](prefix, msg, data)
  } else {
    console[level](prefix, msg)
  }
}

function buildContent(lines: string[], offset = 0): string {
  const end = Math.max(0, lines.length - offset)
  const slice = lines.slice(Math.max(0, end - DISPLAY_MAX_LINES), end).reverse()
  while (slice.length > 0 && slice.join('\n').length > DISPLAY_MAX_BYTES) {
    slice.pop()
  }
  return slice.join('\n') || '(no messages)'
}


export function createPlugin(bridge: Bridge, wsUrl: string, onUpdate?: () => void) {
  let rooms: Array<{ id: string; name: string }> = []
  let displayedRooms: Array<{ id: string; name: string }> = []
  let selectedRoomId: string | null = null
  let lines: string[] = []
  let view: 'rooms' | 'messages' | 'listening' = 'rooms'
  let recognizing = false
  let ws: WebSocket | null = null
  let wsConnected = false
  let errors: string[] = []

  let audioStarted = false
  let seenEventIds: Set<string> = new Set()
  let scrollOffset = 0
  let listeningStartedAt = 0

  function pushError(msg: string, data?: any) {
    const entry = data !== undefined
      ? `${msg}: ${JSON.stringify(data, null, 0)}`
      : msg
    errors = [...errors.slice(-(MAX_ERRORS - 1)), entry]
    onUpdate?.()
  }

  async function showRoomList() {
    log('info', 'showRoomList', { roomCount: rooms.length })
    view = 'rooms'
    displayedRooms = [...rooms].sort((a, b) => a.name.localeCompare(b.name))
    const names = displayedRooms.slice(0, 20).map(r => r.name.slice(0, 64))
    onUpdate?.()
    try {
      await bridge.rebuildPageContainer(new RebuildPageContainer({
        containerTotalNum: 1,
        listObject: [new ListContainerProperty({
          xPosition: 0, yPosition: 0, width: 576, height: 288,
          borderWidth: 0, paddingLength: 4,
          containerID: CONTAINER_ID, containerName: 'rooms',
          itemContainer: new ListItemContainerProperty({
            itemCount: names.length,
            itemName: names,
            isItemSelectBorderEn: 1,
          }),
          isEventCapture: 1,
        })],
      }))
    } catch (err) {
      log('error', 'rebuildPageContainer (rooms) failed', err)
      pushError('rebuildPageContainer (rooms) failed', String(err))
    }
  }

  async function showListeningView() {
    log('info', 'showListeningView')
    view = 'listening'
    onUpdate?.()
    try {
      await bridge.rebuildPageContainer(new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [new TextContainerProperty({
          xPosition: 0, yPosition: 0, width: 576, height: 288,
          borderWidth: 0, paddingLength: 4,
          containerID: CONTAINER_ID, containerName: 'listening',
          content: 'Listening...',
          isEventCapture: 1,
        })],
      }))
    } catch (err) {
      log('error', 'rebuildPageContainer (listening) failed', err)
      pushError('rebuildPageContainer (listening) failed', String(err))
    }
  }

  async function showMessageView(initialLines: string[]) {
    log('info', 'showMessageView', { lineCount: initialLines.length })
    lines = initialLines
    scrollOffset = 0
    view = 'messages'
    onUpdate?.()
    try {
      await bridge.rebuildPageContainer(new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [new TextContainerProperty({
          xPosition: 0, yPosition: 0, width: 576, height: 288,
          borderWidth: 0, paddingLength: 4,
          containerID: CONTAINER_ID, containerName: 'msgs',
          content: buildContent(lines),
          isEventCapture: 1,
        })],
      }))
    } catch (err) {
      log('error', 'rebuildPageContainer (messages) failed', err)
      pushError('rebuildPageContainer (messages) failed', String(err))
    }
  }

  async function appendLine(line: string) {
    lines.push(line)
    onUpdate?.()
    if (view === 'messages' && scrollOffset === 0) {
      try {
        await bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: CONTAINER_ID,
          content: buildContent(lines),
        }))
      } catch (err) {
        log('error', 'textContainerUpgrade (appendLine) failed', err)
        pushError('textContainerUpgrade (appendLine) failed', String(err))
      }
    }
  }

  function send(msg: object) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function sendBinary(data: Uint8Array) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(data)
  }

  function connect() {
    log('info', 'connecting', { wsUrl })
    ws = new WebSocket(wsUrl)
    ws.onopen = () => {
      log('info', 'ws connected')
      wsConnected = true
      onUpdate?.()
      send({ type: 'list_rooms' })
    }
    ws.onmessage = async (e) => {
      let ev: any
      try {
        ev = JSON.parse(e.data)
      } catch (err) {
        log('error', 'ws message parse failed', { raw: e.data, err })
        return
      }
      log('info', 'ws message', { type: ev.type })
      if (ev.type === 'room_list') {
        rooms = ev.rooms
        await showRoomList()
      } else if (ev.type === 'history') {
        seenEventIds = new Set(ev.messages.map((m: { event_id: string }) => m.event_id).filter(Boolean))
        const histLines: string[] = ev.messages.map(
          (m: { sender: string; text: string }) => `${m.sender}: ${m.text}`
        )
        if (view === 'messages') {
          lines = histLines
          if (scrollOffset === 0) {
            try {
              await bridge.textContainerUpgrade(new TextContainerUpgrade({
                containerID: CONTAINER_ID,
                content: buildContent(lines),
              }))
            } catch (err) {
              log('error', 'textContainerUpgrade (history) failed', err)
            }
          }
        } else {
          await showMessageView(histLines)
        }
      } else if (ev.type === 'message') {
        if (ev.event_id && seenEventIds.has(ev.event_id)) return
        if (ev.event_id) seenEventIds.add(ev.event_id)
        if (ev.room_id === selectedRoomId) {
          await appendLine(`${ev.sender}: ${ev.text}`)
        }
      } else {
        log('warn', 'unhandled ws message type', { type: ev.type })
      }
    }
    ws.onerror = (e) => {
      log('error', 'ws error', e)
      pushError('ws error')
    }
    ws.onclose = (e) => {
      log('warn', 'ws closed, reconnecting in 3s', { code: e.code, reason: e.reason })
      wsConnected = false
      onUpdate?.()
      setTimeout(connect, 3000)
    }
  }

  async function stopAudio() {
    log('info', 'stopAudio', { audioStarted })
    recognizing = false
    try {
      await bridge.audioControl(false)
    } catch (err) {
      log('error', 'audioControl(false) failed', err)
      pushError('audioControl(false) failed', String(err))
    }
    if (audioStarted) {
      send({ type: 'audio_end' })
      audioStarted = false
    }
    await showMessageView(lines)
  }

  async function startAudio() {
    log('info', 'startAudio')
    recognizing = true
    listeningStartedAt = Date.now()
    await showListeningView()
    audioStarted = true
    send({ type: 'audio_start' })
    try {
      await bridge.audioControl(true)
    } catch (err) {
      log('error', 'audioControl(true) failed', err)
      pushError('audioControl(true) failed', String(err))
    }
  }

  async function handleEvenHubEvent(event: any) {
    log('info', 'handleEvenHubEvent', { keys: Object.keys(event), view, recognizing })
    if (event.audioEvent && recognizing) {
      const pcm = event.audioEvent.audioPcm
      log('info', 'audioEvent', { type: typeof pcm, byteLength: pcm?.byteLength ?? pcm?.length })
      sendBinary(pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm))
    }
    if (event.listEvent) {
      const et = event.listEvent.eventType
      const isScroll = et === OsEventTypeList.SCROLL_TOP_EVENT || et === OsEventTypeList.SCROLL_BOTTOM_EVENT
      log('info', 'listEvent', { eventType: et, isScroll, currentSelectItemIndex: event.listEvent.currentSelectItemIndex })
      if (!isScroll) {
        const index = event.listEvent.currentSelectItemIndex ?? 0
        const room = displayedRooms[index]
        if (room) {
          log('info', 'room selected', { id: room.id, name: room.name })
          selectedRoomId = room.id
          send({ type: 'select_room', room_id: room.id })
        } else {
          log('warn', 'listEvent index out of range', { index, displayedRoomsLength: displayedRooms.length })
        }
      }
    }
    if (event.sysEvent) {
      const et = event.sysEvent.eventType
      log('info', 'sysEvent', { eventType: et, view, msSinceListeningStart: Date.now() - listeningStartedAt })
      if (view === 'listening' && Date.now() - listeningStartedAt > 1000) {
        await stopAudio()
      } else if (view === 'messages') {
        if (et === OsEventTypeList.DOUBLE_CLICK_EVENT) {
          await startAudio()
        } else if (et === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
          scrollOffset = Math.min(scrollOffset + SCROLL_STEP, Math.max(0, lines.length - 1))
          try {
            await bridge.textContainerUpgrade(new TextContainerUpgrade({
              containerID: CONTAINER_ID,
              content: buildContent(lines, scrollOffset),
            }))
          } catch (err) {
            log('error', 'textContainerUpgrade (scroll down) failed', err)
          }
        } else if (et === OsEventTypeList.SCROLL_TOP_EVENT) {
          scrollOffset = Math.max(0, scrollOffset - SCROLL_STEP)
          try {
            await bridge.textContainerUpgrade(new TextContainerUpgrade({
              containerID: CONTAINER_ID,
              content: buildContent(lines, scrollOffset),
            }))
          } catch (err) {
            log('error', 'textContainerUpgrade (scroll up) failed', err)
          }
        } else if (et === undefined) {
          log('info', 'back gesture (no eventType) → showRoomList')
          await showRoomList()
        } else {
          log('warn', 'unhandled sysEvent in messages view', { eventType: et })
        }
      } else {
        log('warn', 'sysEvent unhandled in view', { view, eventType: et })
      }
    }
  }

  function getState() {
    return { rooms, displayedRooms, selectedRoomId, lines, view, recognizing, scrollOffset, wsConnected, errors }
  }

  return { connect, showRoomList, showMessageView, appendLine, send, startAudio, stopAudio, handleEvenHubEvent, getState }
}
