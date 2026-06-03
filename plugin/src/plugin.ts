import {
  TextContainerProperty,
  TextContainerUpgrade,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

const CONTAINER_ID = 1
const AUDIO_TIMEOUT_MS = 8_000
const CALIBRATION_SAMPLES = 4_000      // 16 kHz × 250 ms
const SILENCE_DURATION_SAMPLES = 24_000 // 16 kHz × 1500 ms
const SILENCE_THRESHOLD_MIN = 0.01

export interface Bridge {
  rebuildPageContainer(c: any): Promise<any>
  textContainerUpgrade(c: any): Promise<any>
  audioControl(open: boolean): Promise<boolean>
}

const DISPLAY_MAX_LINES = 20
const DISPLAY_MAX_BYTES = 990
const SCROLL_STEP = 3

function buildContent(lines: string[], offset = 0): string {
  const end = Math.max(0, lines.length - offset)
  const window = lines.slice(Math.max(0, end - DISPLAY_MAX_LINES), end)
  while (window.length > 0 && window.join('\n').length > DISPLAY_MAX_BYTES) {
    window.shift()
  }
  return window.join('\n') || '(no messages)'
}

function pcmStats(pcm: Uint8Array): { sumSq: number; count: number } {
  const count = Math.floor(pcm.length / 2)
  if (count === 0) return { sumSq: 0, count: 0 }
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let sumSq = 0
  for (let i = 0; i < count; i++) {
    const s = view.getInt16(i * 2, true)
    sumSq += s * s
  }
  return { sumSq, count }
}

export function createPlugin(bridge: Bridge, wsUrl: string) {
  const useSpeechRecognition =
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)

  let rooms: Array<{ id: string; name: string }> = []
  let displayedRooms: Array<{ id: string; name: string }> = []
  let selectedRoomId: string | null = null
  let lines: string[] = []
  let view: 'rooms' | 'messages' | 'listening' = 'rooms'
  let recognizing = false
  let ws: WebSocket | null = null

  let calibrating = false
  let calibSumSq = 0
  let calibSampleCount = 0
  let ambientRms = 0
  let silenceSamples = 0
  let audioStarted = false
  let seenEventIds: Set<string> = new Set()
  let scrollOffset = 0
  let currentRecognition: any = null

  async function showRoomList() {
    view = 'rooms'
    displayedRooms = [...rooms].sort((a, b) => a.name.localeCompare(b.name))
    const names = displayedRooms.slice(0, 20).map(r => r.name.slice(0, 64))
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

  async function showListeningView() {
    view = 'listening'
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
  }

  async function showMessageView(initialLines: string[]) {
    lines = initialLines
    scrollOffset = 0
    view = 'messages'
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
  }

  async function appendLine(line: string) {
    lines.push(line)
    if (view === 'messages' && scrollOffset === 0) {
      await bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: CONTAINER_ID,
        content: buildContent(lines),
      }))
    }
  }

  function send(msg: object) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function sendBinary(data: Uint8Array) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(data)
  }

  function connect() {
    ws = new WebSocket(wsUrl)
    ws.onopen = () => send({ type: 'list_rooms' })
    ws.onmessage = async (e) => {
      const ev = JSON.parse(e.data)
      if (ev.type === 'room_list') {
        rooms = ev.rooms
        await showRoomList()
      } else if (ev.type === 'history') {
        seenEventIds = new Set(ev.messages.map((m: { event_id: string }) => m.event_id).filter(Boolean))
        const histLines: string[] = ev.messages.map(
          (m: { sender: string; text: string }) => `${m.sender}: ${m.text}`
        )
        await showMessageView(histLines)
      } else if (ev.type === 'message') {
        if (ev.event_id && seenEventIds.has(ev.event_id)) return
        if (ev.event_id) seenEventIds.add(ev.event_id)
        if (ev.room_id === selectedRoomId) await appendLine(`${ev.sender}: ${ev.text}`)
      }
    }
    ws.onclose = () => setTimeout(connect, 3000)
  }

  async function stopAudio() {
    recognizing = false
    if (useSpeechRecognition) {
      currentRecognition?.stop()
      currentRecognition = null
    } else {
      calibrating = false
      await bridge.audioControl(false)
      if (audioStarted) {
        send({ type: 'audio_end' })
        audioStarted = false
      }
    }
    await showMessageView(lines)
  }

  async function startAudio() {
    recognizing = true
    await showListeningView()
    if (useSpeechRecognition) {
      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      const recognition = new SR()
      recognition.continuous = false
      recognition.interimResults = false
      recognition.lang = 'en-US'
      recognition.onresult = async (e: any) => {
        const text = e.results[0][0].transcript
        send({ type: 'transcript', text })
        await stopAudio()
      }
      recognition.onend = async () => { if (recognizing) await stopAudio() }
      recognition.onerror = async () => { if (recognizing) await stopAudio() }
      recognition.start()
      currentRecognition = recognition
    } else {
      calibrating = true
      calibSumSq = 0
      calibSampleCount = 0
      ambientRms = 0
      silenceSamples = 0
      audioStarted = false
      await bridge.audioControl(true)
    }
    setTimeout(async () => {
      if (recognizing) await stopAudio()
    }, AUDIO_TIMEOUT_MS)
  }

  async function handleEvenHubEvent(event: any) {
    if (event.audioEvent && !useSpeechRecognition) {
      const pcm: Uint8Array = event.audioEvent.audioPcm
      if (recognizing && calibrating) {
        const { sumSq, count } = pcmStats(pcm)
        calibSumSq += sumSq
        calibSampleCount += count
        if (calibSampleCount >= CALIBRATION_SAMPLES) {
          ambientRms = Math.sqrt(calibSumSq / calibSampleCount) / 32768
          calibrating = false
          audioStarted = true
          send({ type: 'audio_start' })
        }
      } else if (recognizing) {
        sendBinary(pcm)
        const { sumSq, count } = pcmStats(pcm)
        const rms = count > 0 ? Math.sqrt(sumSq / count) / 32768 : 0
        const threshold = Math.max(SILENCE_THRESHOLD_MIN, ambientRms * 2)
        if (rms > threshold) {
          silenceSamples = 0
        } else {
          silenceSamples += count
          if (silenceSamples >= SILENCE_DURATION_SAMPLES) {
            await stopAudio()
          }
        }
      }
    }
    if (event.listEvent) {
      const et = event.listEvent.eventType
      const isScroll = et === OsEventTypeList.SCROLL_TOP_EVENT || et === OsEventTypeList.SCROLL_BOTTOM_EVENT
      if (!isScroll) {
        const index = event.listEvent.currentSelectItemIndex ?? 0
        const room = displayedRooms[index]
        if (room) {
          selectedRoomId = room.id
          send({ type: 'select_room', room_id: room.id })
        }
      }
    }
    if (event.sysEvent && view === 'listening') {
      await stopAudio()
    } else if (event.sysEvent && view === 'messages') {
      const et = event.sysEvent.eventType
      if (et === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        await startAudio()
      } else if (et === OsEventTypeList.SCROLL_TOP_EVENT) {
        scrollOffset = Math.min(scrollOffset + SCROLL_STEP, Math.max(0, lines.length - 1))
        await bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: CONTAINER_ID,
          content: buildContent(lines, scrollOffset),
        }))
      } else if (et === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        scrollOffset = Math.max(0, scrollOffset - SCROLL_STEP)
        await bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: CONTAINER_ID,
          content: buildContent(lines, scrollOffset),
        }))
      } else if (et === undefined) {
        await showRoomList()
      }
    }
  }

  function getState() {
    return { rooms, displayedRooms, selectedRoomId, lines, view, recognizing, calibrating, ambientRms, scrollOffset }
  }

  return { connect, showRoomList, showMessageView, appendLine, send, startAudio, stopAudio, handleEvenHubEvent, getState }
}
