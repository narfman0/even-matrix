import {
  waitForEvenAppBridge,
  OsEventTypeList,
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'

const DEFAULT_HOST = '192.168.1.11:4000'
const STORAGE_KEY_HOST = 'monocle_host'
const TEXT_CONTAINER_ID = 1

interface ServerEvent {
  type: 'message' | 'status' | 'rooms' | 'pong'
  room_alias?: string
  sender?: string
  text?: string
  ts?: number
  rooms?: string[]
  focused?: string
}

interface ClientMsg {
  type: 'transcript' | 'focus' | 'ping'
  text?: string
  room?: string
}

async function main() {
  const bridge = await waitForEvenAppBridge()

  let ws: WebSocket | null = null
  let statusText = 'Connecting...'
  let feedLines: string[] = []
  let recognizing = false

  // Load persisted host or fall back to default
  const savedHost = await bridge.getLocalStorage(STORAGE_KEY_HOST).catch(() => '')
  const host = savedHost || DEFAULT_HOST
  const WS_URL = `ws://${host}/ws`

  await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({
      containerID: TEXT_CONTAINER_ID,
      content: statusText,
    })],
  }))

  async function render() {
    const lines = [statusText, '---', ...feedLines.slice(0, 6)]
    await bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: TEXT_CONTAINER_ID,
      content: lines.join('\n'),
    }))
  }

  function send(msg: ClientMsg) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  function connect() {
    ws = new WebSocket(WS_URL)

    ws.onopen = () => {
      statusText = `Connected (${host})`
      render()
      send({ type: 'ping' })
    }

    ws.onmessage = (e) => {
      const ev: ServerEvent = JSON.parse(e.data)
      if (ev.type === 'message' && ev.sender && ev.text) {
        const line = `[${ev.room_alias ?? '?'}] ${ev.sender}: ${ev.text}`
        feedLines = [line, ...feedLines].slice(0, 8)
        statusText = line
        render()
      } else if (ev.type === 'status' && ev.text) {
        statusText = ev.text
        render()
      } else if (ev.type === 'rooms') {
        render()
      }
    }

    ws.onclose = () => {
      statusText = 'Disconnected -- retrying...'
      render()
      setTimeout(connect, 3000)
    }

    ws.onerror = () => {
      statusText = 'WebSocket error'
      render()
    }
  }

  async function handleTranscript(transcript: string) {
    const lower = transcript.toLowerCase().trim()

    // "set server 192.168.1.11" or "set server 192.168.1.11:4000"
    const setServerMatch = lower.match(/^set server\s+([\d.:]+)$/)
    if (setServerMatch) {
      let newHost = setServerMatch[1]
      if (!newHost.includes(':')) newHost += ':4000'
      await bridge.setLocalStorage(STORAGE_KEY_HOST, newHost)
      statusText = `Server set to ${newHost} — restart to apply`
      render()
      return
    }

    send({ type: 'transcript', text: transcript })
  }

  function startVoice() {
    const SR =
      (window as unknown as Record<string, unknown>)['SpeechRecognition'] ??
      (window as unknown as Record<string, unknown>)['webkitSpeechRecognition']

    if (!SR) {
      statusText = 'No STT available'
      render()
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec = new (SR as any)()
    rec.lang = 'en-US'
    rec.interimResults = false
    rec.maxAlternatives = 1

    recognizing = true
    statusText = 'Listening...'
    render()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (event: any) => {
      const transcript: string = event.results[0][0].transcript
      statusText = `Heard: ${transcript}`
      render()
      handleTranscript(transcript)
    }

    rec.onend = () => {
      recognizing = false
      render()
    }

    rec.onerror = () => {
      recognizing = false
      statusText = 'Voice error'
      render()
    }

    rec.start()
  }

  bridge.onEvenHubEvent((event) => {
    const sys = event.sysEvent
    if (!sys) return

    switch (sys.eventType) {
      case OsEventTypeList.CLICK_EVENT:
        send({ type: 'ping' })
        break

      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        if (!recognizing) startVoice()
        break

      default:
        break
    }
  })

  connect()
  render()
}

main().catch(console.error)
