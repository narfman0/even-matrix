import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

const DEFAULT_HOST = 'localhost:4000'
const STORAGE_KEY_HOST = 'monocle_host'
const CONTAINER_ID = 1

async function main() {
  const bridge = await waitForEvenAppBridge()

  let rooms: Array<{ id: string; name: string }> = []
  let selectedRoomId: string | null = null
  let lines: string[] = []
  let view: 'rooms' | 'messages' = 'rooms'
  let recognizing = false
  let ws: WebSocket | null = null

  await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: 576, height: 288,
        borderWidth: 0, paddingLength: 4,
        containerID: CONTAINER_ID, containerName: 'status',
        content: 'Connecting...', isEventCapture: 1,
      })],
    })
  )

  async function showRoomList() {
    view = 'rooms'
    const names = rooms.slice(0, 20).map(r => r.name.slice(0, 64))
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
  }

  async function showMessageView(initialLines: string[]) {
    lines = initialLines
    view = 'messages'
    await bridge.rebuildPageContainer(new RebuildPageContainer({
      containerTotalNum: 1,
      textObject: [new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: 576, height: 288,
        borderWidth: 0, paddingLength: 4,
        containerID: CONTAINER_ID, containerName: 'msgs',
        content: lines.slice(-8).join('\n') || '(no messages)',
        isEventCapture: 1,
      })],
    }))
  }

  async function appendLine(line: string) {
    lines.push(line)
    if (view === 'messages') {
      await bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: CONTAINER_ID,
        content: lines.slice(-8).join('\n'),
      }))
    }
  }

  function send(msg: object) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  const savedHost = await bridge.getLocalStorage(STORAGE_KEY_HOST).catch(() => '')
  const host = savedHost || DEFAULT_HOST
  const WS_URL = `ws://${host}/ws`

  function connect() {
    ws = new WebSocket(WS_URL)
    ws.onopen = () => send({ type: 'list_rooms' })
    ws.onmessage = async (e) => {
      const ev = JSON.parse(e.data)
      if (ev.type === 'room_list') {
        rooms = ev.rooms
        await showRoomList()
      } else if (ev.type === 'history') {
        const histLines: string[] = ev.messages.map(
          (m: { sender: string; text: string }) => `${m.sender}: ${m.text}`
        )
        await showMessageView(histLines)
      } else if (ev.type === 'message') {
        if (ev.room_id === selectedRoomId) await appendLine(`${ev.sender}: ${ev.text}`)
      } else if (ev.type === 'status') {
        if (view === 'messages') await appendLine(ev.text)
      }
    }
    ws.onclose = () => setTimeout(connect, 3000)
  }

  async function startVoice() {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
    if (!SR) { await appendLine('No STT'); return }
    const rec = new SR()
    rec.lang = 'en-US'
    rec.interimResults = false
    rec.maxAlternatives = 1
    recognizing = true
    await appendLine('Listening...')
    rec.onresult = async (e: any) => {
      const t: string = e.results[0][0].transcript
      await appendLine(`> ${t}`)
      send({ type: 'transcript', text: t })
    }
    rec.onend = () => { recognizing = false }
    rec.onerror = () => { recognizing = false }
    rec.start()
  }

  bridge.onEvenHubEvent(async (event) => {
    if (event.listEvent) {
      const et = event.listEvent.eventType
      const isScroll = et === OsEventTypeList.SCROLL_TOP_EVENT || et === OsEventTypeList.SCROLL_BOTTOM_EVENT
      if (!isScroll) {
        const index = event.listEvent.currentSelectItemIndex ?? 0
        const room = rooms[index]
        if (room) {
          selectedRoomId = room.id
          send({ type: 'select_room', room_id: room.id })
        }
      }
    }
    if (event.sysEvent && view === 'messages') {
      if (event.sysEvent.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT && !recognizing) {
        await startVoice()
      } else if (event.sysEvent.eventType === undefined) {
        await showRoomList()
      }
    }
  })

  connect()
}

main().catch(console.error)
