import {
  waitForEvenAppBridge,
  OsEventTypeList,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  ListContainerProperty,
  ListItemContainerProperty,
} from '@evenrealities/even_hub_sdk'

const DEFAULT_HOST = '192.168.1.11:4000'
const STORAGE_KEY_HOST = 'monocle_host'

const CONTAINER_LIST = 1
const CONTAINER_TEXT = 2

// ── Server message types ────────────────────────────────────────────────────

interface RoomInfo { id: string; name: string }
interface HistMsg  { sender: string; text: string; ts: number }

type ServerEvent =
  | { type: 'room_list';  rooms: RoomInfo[] }
  | { type: 'history';    room_id: string; messages: HistMsg[] }
  | { type: 'message';    room_id: string; room_alias: string; sender: string; text: string; ts: number }
  | { type: 'status';     text: string }
  | { type: 'pong' }

type ClientMsg =
  | { type: 'list_rooms' }
  | { type: 'select_room'; room_id: string }
  | { type: 'transcript';  text: string }
  | { type: 'ping' }

// ── App state ───────────────────────────────────────────────────────────────

type View = 'connecting' | 'rooms' | 'room'

let view: View = 'connecting'
let rooms: RoomInfo[] = []
let roomListIndex = 0          // focused row in room list
let currentRoomId = ''
let currentRoomName = ''
let messages: HistMsg[] = []
let msgOffset = 0              // scroll offset into messages (0 = latest)
let statusLine = 'Connecting...'
let recognizing = false

// ── Helpers ─────────────────────────────────────────────────────────────────

const MSG_PAGE = 5

function visibleMessages(): HistMsg[] {
  const start = Math.max(0, messages.length - MSG_PAGE - msgOffset)
  return messages.slice(start, start + MSG_PAGE)
}

// ── Render ──────────────────────────────────────────────────────────────────

async function renderRooms(bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>>) {
  await bridge.rebuildPageContainer(new RebuildPageContainer({
    containerTotalNum: 1,
    listObject: [new ListContainerProperty({
      containerID: CONTAINER_LIST,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: rooms.length || 1,
        itemName: rooms.length ? rooms.map(r => r.name) : ['Loading...'],
        isItemSelectBorderEn: 1,
      }),
    })],
  }))
}

async function renderRoom(bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>>) {
  const visible = visibleMessages()
  const lines = [
    `${currentRoomName}  [dbl=voice, say "back"]`,
    '─────────────────',
    ...(visible.length
      ? visible.map(m => `${m.sender}: ${m.text}`)
      : ['(no messages yet)']),
    msgOffset > 0 ? `↑ scroll up for newer` : '',
  ].filter(l => l !== '')

  await bridge.rebuildPageContainer(new RebuildPageContainer({
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({
      containerID: CONTAINER_TEXT,
      content: lines.join('\n'),
    })],
  }))
}

async function renderStatus(bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>>) {
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: CONTAINER_TEXT,
    content: statusLine,
  }))
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const bridge = await waitForEvenAppBridge()

  const savedHost = await bridge.getLocalStorage(STORAGE_KEY_HOST).catch(() => '')
  const host = savedHost || DEFAULT_HOST
  const WS_URL = `ws://${host}/ws`

  // Initial container — text only until we have rooms
  await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({
      containerID: CONTAINER_TEXT,
      content: statusLine,
    })],
  }))

  let ws: WebSocket | null = null

  function send(msg: ClientMsg) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function connect() {
    ws = new WebSocket(WS_URL)

    ws.onopen = async () => {
      statusLine = 'Connected — loading rooms...'
      await renderStatus(bridge)
      send({ type: 'list_rooms' })
    }

    ws.onmessage = async (e) => {
      const ev: ServerEvent = JSON.parse(e.data)

      if (ev.type === 'room_list') {
        rooms = ev.rooms
        roomListIndex = 0
        view = 'rooms'
        await renderRooms(bridge)

      } else if (ev.type === 'history') {
        messages = ev.messages
        msgOffset = 0
        view = 'room'
        await renderRoom(bridge)

      } else if (ev.type === 'message') {
        // Append to cache
        messages.push({ sender: ev.sender, text: ev.text, ts: ev.ts })
        if (view === 'room' && ev.room_id === currentRoomId && msgOffset === 0) {
          await renderRoom(bridge)
        }

      } else if (ev.type === 'status') {
        statusLine = ev.text
        if (view === 'connecting') await renderStatus(bridge)
      }
    }

    ws.onclose = async () => {
      view = 'connecting'
      statusLine = 'Disconnected — retrying...'
      await renderStatus(bridge)
      setTimeout(connect, 3000)
    }

    ws.onerror = async () => {
      statusLine = 'WebSocket error'
      await renderStatus(bridge)
    }
  }

  // ── Voice ──────────────────────────────────────────────────────────────────

  async function handleTranscript(transcript: string) {
    const lower = transcript.toLowerCase().trim()

    // Settings command works from any view
    const setServerMatch = lower.match(/^set server\s+([\d.:]+)$/)
    if (setServerMatch) {
      let newHost = setServerMatch[1]
      if (!newHost.includes(':')) newHost += ':4000'
      await bridge.setLocalStorage(STORAGE_KEY_HOST, newHost)
      statusLine = `Server set to ${newHost} — restart to apply`
      await renderStatus(bridge)
      return
    }

    if (view === 'room') {
      if (lower === 'back' || lower === 'go back') {
        view = 'rooms'
        await renderRooms(bridge)
        return
      }
      // Everything else: send as message to current room
      statusLine = `Heard: ${transcript}`
      await renderStatus(bridge)
      send({ type: 'transcript', text: transcript })
      return
    }

    if (view === 'rooms') {
      // Allow voice room selection by name
      const match = rooms.findIndex(r => r.name.toLowerCase() === lower)
      if (match >= 0) {
        roomListIndex = match
        currentRoomId = rooms[match].id
        currentRoomName = rooms[match].name
        send({ type: 'select_room', room_id: currentRoomId })
      }
    }
  }

  function startVoice() {
    const SR =
      (window as unknown as Record<string, unknown>)['SpeechRecognition'] ??
      (window as unknown as Record<string, unknown>)['webkitSpeechRecognition']
    if (!SR) { statusLine = 'No STT'; return }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec = new (SR as any)()
    rec.lang = 'en-US'
    rec.interimResults = false
    rec.maxAlternatives = 1
    recognizing = true

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (event: any) => {
      const transcript: string = event.results[0][0].transcript
      handleTranscript(transcript)
    }
    rec.onend = () => { recognizing = false }
    rec.onerror = () => { recognizing = false }
    rec.start()
  }

  // ── Input events ───────────────────────────────────────────────────────────

  bridge.onEvenHubEvent(async (event) => {
    // Native list item selection (tap on a list row)
    if (event.listEvent && view === 'rooms') {
      const idx = event.listEvent.currentSelectItemIndex ?? 0
      if (idx < rooms.length) {
        roomListIndex = idx
        currentRoomId = rooms[idx].id
        currentRoomName = rooms[idx].name
        send({ type: 'select_room', room_id: currentRoomId })
      }
      return
    }

    const sys = event.sysEvent
    if (!sys) return

    switch (sys.eventType) {
      case OsEventTypeList.SCROLL_TOP_EVENT:
        if (view === 'rooms') {
          roomListIndex = Math.max(0, roomListIndex - 1)
        } else if (view === 'room') {
          // scroll up = see older messages
          msgOffset = Math.min(msgOffset + MSG_PAGE, Math.max(0, messages.length - MSG_PAGE))
          await renderRoom(bridge)
        }
        break

      case OsEventTypeList.SCROLL_BOTTOM_EVENT:
        if (view === 'rooms') {
          roomListIndex = Math.min(rooms.length - 1, roomListIndex + 1)
        } else if (view === 'room') {
          // scroll down = see newer messages
          msgOffset = Math.max(0, msgOffset - MSG_PAGE)
          await renderRoom(bridge)
        }
        break

      case OsEventTypeList.CLICK_EVENT:
        if (view === 'rooms' && rooms.length > 0) {
          currentRoomId = rooms[roomListIndex].id
          currentRoomName = rooms[roomListIndex].name
          send({ type: 'select_room', room_id: currentRoomId })
        }
        break

      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        if (!recognizing) startVoice()
        break

      case OsEventTypeList.FOREGROUND_ENTER_EVENT:
        // Refresh room list on re-focus
        send({ type: 'list_rooms' })
        break

      default:
        break
    }
  })

  connect()
}

main().catch(console.error)
