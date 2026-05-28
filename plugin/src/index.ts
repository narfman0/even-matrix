import { waitForEvenAppBridge, OsEventTypeList } from '@evenrealities/even_hub_sdk'

const WS_URL = 'ws://localhost:4000/ws'

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

  // --- WebSocket to Rust orchestrator ---
  let ws: WebSocket | null = null
  let statusText = 'Connecting...'
  let feedLines: string[] = []
  let recognizing = false

  function send(msg: ClientMsg) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  function render() {
    const lines = [
      statusText,
      '---',
      ...feedLines.slice(0, 6),
    ]
    bridge.sendTextToGlasses(lines.join('\n'))
  }

  function connect() {
    ws = new WebSocket(WS_URL)

    ws.onopen = () => {
      statusText = 'Connected'
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

  connect()

  // --- Speech recognition ---
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
      send({ type: 'transcript', text: transcript })
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

  // --- G2 input events ---
  bridge.onEvenHubEvent((event) => {
    const sys = event.sysEvent
    if (!sys) return

    switch (sys.eventType) {
      case OsEventTypeList.CLICK_EVENT:
        // Single tap: send ping / cycle rooms
        send({ type: 'ping' })
        break

      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        // Double tap: start voice input
        if (!recognizing) startVoice()
        break

      default:
        break
    }
  })

  render()
}

main().catch(console.error)
