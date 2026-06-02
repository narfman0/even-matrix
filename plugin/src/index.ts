import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

const DEFAULT_HOST = '192.168.1.11:4000'
const STORAGE_KEY_HOST = 'monocle_host'
const CONTAINER_ID = 1

const mainText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  paddingLength: 4,
  containerID: CONTAINER_ID,
  containerName: 'main',
  content: 'Connecting...',
  isEventCapture: 1,
})

async function main() {
  const bridge = await waitForEvenAppBridge()

  await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [mainText] })
  )

  async function setText(content: string) {
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: CONTAINER_ID, content })
    )
  }

  const savedHost = await bridge.getLocalStorage(STORAGE_KEY_HOST).catch(() => '')
  const host = savedHost || DEFAULT_HOST
  const WS_URL = `ws://${host}/ws`

  let ws: WebSocket | null = null
  let lines: string[] = []
  let recognizing = false

  function render() {
    setText(lines.slice(-8).join('\n') || '(no messages)')
  }

  function send(msg: object) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function connect() {
    ws = new WebSocket(WS_URL)
    ws.onopen = () => { lines = [`Connected to ${host}`]; render(); send({ type: 'list_rooms' }) }
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data)
      if (ev.type === 'room_list') {
        lines = ['Rooms:', ...ev.rooms.map((r: { name: string }) => `  ${r.name}`)]
        render()
      } else if (ev.type === 'message') {
        lines.push(`${ev.sender}: ${ev.text}`)
        render()
      } else if (ev.type === 'status') {
        lines.push(ev.text)
        render()
      }
    }
    ws.onclose = () => { lines = ['Disconnected, retrying...']; render(); setTimeout(connect, 3000) }
    ws.onerror = () => { lines = ['WebSocket error']; render() }
  }

  function startVoice() {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
    if (!SR) { lines.push('No STT'); render(); return }
    const rec = new SR()
    rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1
    recognizing = true
    lines.push('Listening...')
    render()
    rec.onresult = (e: any) => {
      const t: string = e.results[0][0].transcript
      lines.push(`> ${t}`)
      render()
      send({ type: 'transcript', text: t })
    }
    rec.onend = () => { recognizing = false }
    rec.onerror = () => { recognizing = false }
    rec.start()
  }

  bridge.onEvenHubEvent(async (event) => {
    const sys = event.sysEvent
    if (!sys) return
    if (sys.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT && !recognizing) startVoice()
  })

  connect()
}

main().catch(console.error)
