import {
  TextContainerProperty,
  TextContainerUpgrade,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import type { MatrixClient, MatrixMessage, RoomHierarchy, RoomInfo, SpaceInfo } from './matrix-client'
import { formatAge } from './message-utils'

const CONTAINER_ID = 1

export interface Bridge {
  rebuildPageContainer(c: any): Promise<any>
  textContainerUpgrade(c: any): Promise<any>
  audioControl(open: boolean): Promise<boolean>
}

const DISPLAY_MAX_BYTES = 999
const SCROLL_STEP = 3
const ROLLING_INTERVAL_MS = 3000
const ROLLING_MIN_BYTES = 32000
const AUDIO_MAX_BYTES = 10 * 1024 * 1024
const enc = new TextEncoder()

type DisplayItem = RoomInfo & { isHeader: boolean }

function buildDisplayedRooms(h: RoomHierarchy): DisplayItem[] {
  const result: DisplayItem[] = []
  const hasSections = h.dms.length > 0 || h.spaces.length > 0
  if (h.dms.length > 0) {
    result.push({ id: '', name: '── DMs ──', isHeader: true })
    h.dms.forEach(r => result.push({ ...r, isHeader: false }))
  }
  h.spaces.forEach(space => {
    result.push({ id: space.id, name: `── ${space.name} ──`, isHeader: true })
    space.rooms.forEach(r => result.push({ ...r, isHeader: false }))
  })
  if (h.orphans.length > 0) {
    if (hasSections) result.push({ id: '', name: '── Other ──', isHeader: true })
    h.orphans.forEach(r => result.push({ ...r, isHeader: false }))
  }
  return result
}

const MAX_ERRORS = 50

function log(level: 'info' | 'warn' | 'error', msg: string, data?: any) {
  const prefix = `[even-matrix] [${level.toUpperCase()}]`
  if (data !== undefined) {
    console[level](prefix, msg, data)
  } else {
    console[level](prefix, msg)
  }
}

function byteLen(s: string): number {
  return enc.encode(s).length
}

function truncateToBytes(s: string, max: number): string {
  const bytes = enc.encode(s)
  if (bytes.length <= max) return s
  let cut = max - 3 // reserve 3 bytes for the ellipsis (… is 3 bytes in UTF-8)
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut-- // back off continuation bytes
  return new TextDecoder().decode(bytes.slice(0, cut)) + '…'
}

function isMention(text: string, userId: string): boolean {
  if (!userId) return false
  const localPart = userId.split(':')[0].replace(/^@/, '').toLowerCase()
  if (!localPart) return false
  return text.toLowerCase().includes(localPart)
}

function buildContent(lines: string[], offset = 0): string {
  const end = Math.max(0, lines.length - offset)
  const slice = lines.slice(0, end).reverse()
  while (slice.length > 0 && byteLen(slice.join('\n')) > DISPLAY_MAX_BYTES) {
    slice.pop()
  }
  if (slice.length === 0 && end > 0) {
    return truncateToBytes(lines[end - 1], DISPLAY_MAX_BYTES)
  }
  return slice.join('\n') || '(no messages)'
}

function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((n, c) => n + c.length, 0)
  const merged = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
  const blockAlign = (numChannels * bitsPerSample) / 8
  const dataSize = pcm.length
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  const writeStr = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  new Uint8Array(buf).set(pcm, 44)
  return new Uint8Array(buf)
}

export function createPlugin(
  bridge: Bridge,
  matrix: MatrixClient,
  whisperUrl: string | null = null,
  whisperModel: string = 'Systran/faster-distil-whisper-small.en',
  onUpdate?: () => void,
  userId: string = ''
) {
  let hierarchy: RoomHierarchy = { dms: [], spaces: [], orphans: [] }
  let displayedRooms: DisplayItem[] = []
  let selectedRoomId: string | null = null
  let lines: string[] = []
  let mentions: boolean[] = []
  let mentioned: boolean = false
  let view: 'rooms' | 'messages' | 'listening' | 'loading' | 'transcribing' | 'sending' | 'verification' = 'rooms'
  let loadingRoomName: string = ''
  let transcribedText: string = ''
  let verificationRequest: any | null = null
  let verificationEmoji: string[] = []
  let recognizing = false
  let matrixConnected = false
  let syncToken: string | null = null
  let errors: string[] = []

  let lastSyncAt: number | null = null
  let unreadRooms: Set<string> = new Set()
  let audioBuf: Uint8Array[] = []
  let audioLevel: number = 0
  let seenEventIds: Set<string> = new Set()
  let scrollOffset = 0
  let prevBatch: string | null = null
  let loadingMore = false
  let listeningStartedAt = 0
  let navSeq = 0
  let roomNavStartedAt = 0
  let navAbort: AbortController | null = null
  let rollingTimer: ReturnType<typeof setTimeout> | null = null
  let rollingAbort: AbortController | null = null
  let messageCache: Map<string, MatrixMessage> = new Map()
  let reactions: Map<string, Map<string, number>> = new Map()

  function pushError(msg: string, data?: any) {
    const entry = data !== undefined
      ? `${msg}: ${JSON.stringify(data, null, 0)}`
      : msg
    errors = [...errors.slice(-(MAX_ERRORS - 1)), entry]
    onUpdate?.()
  }

  async function showRoomList() {
    navAbort?.abort()
    navAbort = null
    log('info', 'showRoomList', { dms: hierarchy.dms.length, spaces: hierarchy.spaces.length, orphans: hierarchy.orphans.length })
    view = 'rooms'
    displayedRooms = buildDisplayedRooms(hierarchy)
    const names = displayedRooms.map(r => r.name.slice(0, 64))
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

  async function showTranscribingView() {
    log('info', 'showTranscribingView')
    view = 'transcribing'
    transcribedText = ''
    onUpdate?.()
    try {
      await bridge.rebuildPageContainer(new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [new TextContainerProperty({
          xPosition: 0, yPosition: 0, width: 576, height: 288,
          borderWidth: 0, paddingLength: 4,
          containerID: CONTAINER_ID, containerName: 'transcribing',
          content: 'Transcribing...',
          isEventCapture: 1,
        })],
      }))
    } catch (err) {
      log('error', 'rebuildPageContainer (transcribing) failed', err)
      pushError('rebuildPageContainer (transcribing) failed', String(err))
    }
  }

  async function updateTranscribingText(text: string) {
    transcribedText = text
    onUpdate?.()
    if (view === 'transcribing') {
      try {
        await bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: CONTAINER_ID,
          content: text,
        }))
      } catch (err) {
        log('error', 'textContainerUpgrade (transcribing) failed', err)
      }
    }
  }

  async function showSendingView(text: string) {
    log('info', 'showSendingView', { text })
    view = 'sending'
    transcribedText = text
    onUpdate?.()
    try {
      await bridge.rebuildPageContainer(new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [new TextContainerProperty({
          xPosition: 0, yPosition: 0, width: 576, height: 288,
          borderWidth: 0, paddingLength: 4,
          containerID: CONTAINER_ID, containerName: 'sending',
          content: `Sending: ${text.slice(0, 80)}`,
          isEventCapture: 1,
        })],
      }))
    } catch (err) {
      log('error', 'rebuildPageContainer (sending) failed', err)
      pushError('rebuildPageContainer (sending) failed', String(err))
    }
  }

  async function showLoadingView(roomName: string) {
    log('info', 'showLoadingView', { roomName })
    loadingRoomName = roomName
    view = 'loading'
    onUpdate?.()
    try {
      await bridge.rebuildPageContainer(new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [new TextContainerProperty({
          xPosition: 0, yPosition: 0, width: 576, height: 288,
          borderWidth: 0, paddingLength: 4,
          containerID: CONTAINER_ID, containerName: 'loading',
          content: `Loading ${roomName}...`,
          isEventCapture: 1,
        })],
      }))
    } catch (err) {
      log('error', 'rebuildPageContainer (loading) failed', err)
      pushError('rebuildPageContainer (loading) failed', String(err))
    }
  }

  async function showMessageView(initialLines: string[]) {
    log('info', 'showMessageView', { lineCount: initialLines.length })
    lines = initialLines
    mentions = initialLines.map(l => isMention(l, userId))
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

  async function appendLine(line: string, isMentionLine = false) {
    lines.push(line)
    mentions.push(isMentionLine)
    if (isMentionLine) mentioned = true
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

  function buildRoomLines(msgs: MatrixMessage[]): string[] {
    const result: string[] = []
    for (const msg of msgs) {
      if (msg.replyTo) {
        const quoted = messageCache.get(msg.replyTo)
        if (quoted) {
          const quoteText = quoted.text.slice(0, 40) + (quoted.text.length > 40 ? '…' : '')
          result.push(`  ↩ ${quoted.sender}: ${quoteText}`)
        }
      }
      result.push(buildMessageLine(msg))
    }
    return result
  }

  function buildMentionFlags(msgs: MatrixMessage[]): boolean[] {
    const result: boolean[] = []
    for (const msg of msgs) {
      if (msg.replyTo && messageCache.has(msg.replyTo)) {
        result.push(false)
      }
      result.push(isMention(msg.text, userId))
    }
    return result
  }

  async function onSyncMessage(roomId: string, eventId: string, sender: string, text: string, replyTo?: string) {
    if (eventId && seenEventIds.has(eventId)) return
    if (eventId) seenEventIds.add(eventId)
    if (roomId === selectedRoomId) {
      const newMsg: MatrixMessage = { event_id: eventId, sender, text, ts: Math.floor(Date.now() / 1000), replyTo }
      if (eventId) messageCache.set(eventId, newMsg)
      currentRoomMessages.push(newMsg)
      if (replyTo) {
        const quoted = messageCache.get(replyTo)
        if (quoted) {
          const quoteText = quoted.text.slice(0, 40) + (quoted.text.length > 40 ? '…' : '')
          await appendLine(`  ↩ ${quoted.sender}: ${quoteText}`, false)
        }
      }
      const line = buildMessageLine(newMsg)
      await appendLine(line, isMention(text, userId))
    } else {
      unreadRooms.add(roomId)
      onUpdate?.()
    }
  }

  function onSyncReaction(roomId: string, targetEventId: string, emoji: string) {
    if (roomId !== selectedRoomId) return
    if (!reactions.has(targetEventId)) reactions.set(targetEventId, new Map())
    const m = reactions.get(targetEventId)!
    m.set(emoji, (m.get(emoji) ?? 0) + 1)
    // Rebuild lines to reflect updated reaction counts
    rebuildLinesFromCache()
  }

  function buildMessageLine(msg: MatrixMessage): string {
    const age = formatAge(msg.ts * 1000)
    const base = `[${age}] ${msg.sender}: ${msg.text}`
    const reacts = reactions.get(msg.event_id)
    if (!reacts || reacts.size === 0) return base
    const top = [...reacts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([e, c]) => `${e}${c}`)
      .join(',')
    return `${base}||REACT:${top}`
  }

  function rebuildLinesFromCache() {
    // Rebuild lines array from messageCache for the current room
    // We keep an ordered list of event_ids for the current room
    const newLines: string[] = []
    const newMentions: boolean[] = []
    for (const msg of currentRoomMessages) {
      if (msg.replyTo) {
        const quoted = messageCache.get(msg.replyTo)
        if (quoted) {
          const quoteText = quoted.text.slice(0, 40) + (quoted.text.length > 40 ? '…' : '')
          newLines.push(`  ↩ ${quoted.sender}: ${quoteText}`)
          newMentions.push(false)
        }
      }
      newLines.push(buildMessageLine(msg))
      newMentions.push(isMention(msg.text, userId))
    }
    lines = newLines
    mentions = newMentions
    onUpdate?.()
  }

  let currentRoomMessages: MatrixMessage[] = []

  async function showVerificationView(emoji: string[]) {
    verificationEmoji = emoji
    view = 'verification'
    onUpdate?.()
    try {
      await bridge.rebuildPageContainer(new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [new TextContainerProperty({
          xPosition: 0, yPosition: 0, width: 576, height: 288,
          borderWidth: 0, paddingLength: 4,
          containerID: CONTAINER_ID, containerName: 'verification',
          content: emoji.length > 0
            ? `Verify Device\n${emoji.join(' ')}\nTap=confirm Back=reject`
            : 'Verify Device\nWaiting for emoji…',
          isEventCapture: 1,
        })],
      }))
    } catch (err) {
      log('error', 'rebuildPageContainer (verification) failed', err)
      pushError('rebuildPageContainer (verification) failed', String(err))
    }
  }

  function setupVerificationHandler() {
    matrix.onVerificationRequest?.((request: any) => {
      verificationRequest = request
      verificationEmoji = []
      view = 'verification'
      onUpdate?.()
      // Show the waiting state immediately, then fill in emoji when SAS is ready
      showVerificationView([]).catch(() => {})
      matrix.runSasVerification?.(request).then((emojis: string[]) => {
        verificationEmoji = emojis
        onUpdate?.()
        showVerificationView(emojis).catch(() => {})
      }).catch(() => {
        view = 'rooms'
        verificationRequest = null
        verificationEmoji = []
        onUpdate?.()
      })
    })
  }

  async function confirmVerification() {
    if (!verificationRequest) return
    const req = verificationRequest
    verificationRequest = null
    verificationEmoji = []
    view = 'rooms'
    onUpdate?.()
    try {
      await matrix.confirmSas?.(req)
    } catch (err) {
      log('error', 'confirmSas failed', err)
      pushError('confirmSas failed', String(err))
    }
    await showRoomList()
  }

  async function rejectVerification() {
    if (!verificationRequest) return
    const req = verificationRequest
    verificationRequest = null
    verificationEmoji = []
    view = 'rooms'
    onUpdate?.()
    try {
      await matrix.rejectSas?.(req)
    } catch (err) {
      log('error', 'rejectSas failed', err)
      pushError('rejectSas failed', String(err))
    }
    await showRoomList()
  }

  async function start(token: string | null) {
    log('info', 'start', { token })
    matrixConnected = true
    syncToken = token
    onUpdate?.()
    try {
      const { hierarchy: h, nextBatch } = await matrix.initialSync()
      hierarchy = h
      await showRoomList()
      matrix.startSyncLoop(token ?? nextBatch, onSyncMessage, (newToken) => {
        syncToken = newToken
        lastSyncAt = Date.now()
        onUpdate?.()
      }, onSyncReaction)
    } catch (err) {
      log('error', 'start failed', err)
      pushError('start failed', String(err))
    }
  }

  async function transcribeAndSend(chunks: Uint8Array[], roomId: string) {
    try {
      await showTranscribingView()
      const wav = pcmToWav(mergeChunks(chunks), 16000)
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
      form.append('model', whisperModel)
      form.append('stream', 'true')
      const res = await fetch(`${whisperUrl}/v1/audio/transcriptions`, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`whisper: ${res.status}`)

      let text = ''
      if (res.headers?.get?.('content-type')?.includes('text/event-stream') && res.body) {
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? '' // buf carries incomplete lines across reads
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6).trim()
            if (raw === '[DONE]') continue
            try {
              const { text: t } = JSON.parse(raw) as { text?: string }
              if (t !== undefined) { text += t; await updateTranscribingText(text) }
            } catch {}
          }
        }
      } else {
        const json = await res.json() as { text?: string }
        text = json.text ?? ''
      }

      if (text.trim()) {
        await showSendingView(text.trim())
        await matrix.sendMessage(roomId, text.trim())
      }
    } catch (err) {
      log('error', 'transcribeAndSend failed', err)
      pushError('transcribeAndSend failed', String(err))
    }
  }

  async function updateListeningText(text: string) {
    transcribedText = text
    onUpdate?.()
    if (view === 'listening') {
      try {
        await bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: CONTAINER_ID,
          content: text || 'Listening...',
        }))
      } catch (err) {
        log('error', 'textContainerUpgrade (listening partial) failed', err)
      }
    }
  }

  async function fireRollingTranscription(chunks: Uint8Array[], signal: AbortSignal) {
    if (!whisperUrl || chunks.length === 0) return
    const totalBytes = chunks.reduce((n, c) => n + c.length, 0)
    if (totalBytes < ROLLING_MIN_BYTES) return
    try {
      const wav = pcmToWav(mergeChunks(chunks), 16000)
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
      form.append('model', whisperModel)
      const res = await fetch(`${whisperUrl}/v1/audio/transcriptions`, { method: 'POST', body: form, signal })
      if (!res.ok) return
      const json = await res.json() as { text?: string }
      const text = json.text?.trim()
      if (text && !signal.aborted) await updateListeningText(text)
    } catch (err) {
      if ((err as any)?.name !== 'AbortError') log('warn', 'rolling transcription failed', err)
    }
  }

  function scheduleRolling() {
    rollingTimer = setTimeout(async () => {
      if (!recognizing) return
      const chunks = audioBuf.slice()
      rollingAbort?.abort()
      rollingAbort = new AbortController()
      await fireRollingTranscription(chunks, rollingAbort.signal)
      if (recognizing) scheduleRolling()
    }, ROLLING_INTERVAL_MS)
  }

  function computeRms(pcm: Uint8Array): number {
    const samples = pcm.length / 2
    let sum = 0
    for (let i = 0; i < pcm.length; i += 2) {
      const s = (pcm[i] | (pcm[i + 1] << 8)) << 16 >> 16  // signed 16-bit
      sum += s * s
    }
    return Math.sqrt(sum / samples) / 32768
  }

  async function stopAudio() {
    if (!recognizing) return
    log('info', 'stopAudio', { audioBufChunks: audioBuf.length })
    recognizing = false
    audioLevel = 0
    if (rollingTimer !== null) { clearTimeout(rollingTimer); rollingTimer = null }
    rollingAbort?.abort(); rollingAbort = null
    const chunks = audioBuf
    const roomId = selectedRoomId
    audioBuf = []
    try {
      await bridge.audioControl(false)
    } catch (err) {
      log('error', 'audioControl(false) failed', err)
      pushError('audioControl(false) failed', String(err))
    }
    if (whisperUrl && chunks.length > 0 && roomId) {
      await transcribeAndSend(chunks, roomId)
    }
    await showMessageView(lines)
  }

  async function startAudio() {
    log('info', 'startAudio')
    recognizing = true
    listeningStartedAt = Date.now()
    audioBuf = []
    transcribedText = ''
    await showListeningView()
    scheduleRolling()
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
      const chunk = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm)
      const currentBytes = audioBuf.reduce((n, c) => n + c.length, 0)
      if (currentBytes + chunk.length <= AUDIO_MAX_BYTES) {
        audioBuf.push(chunk)
      } else {
        log('warn', 'audio buffer cap reached, dropping chunk')
      }
      audioLevel = computeRms(chunk)
      onUpdate?.()
    }
    if (event.listEvent) {
      const et = event.listEvent.eventType
      const isScroll = et === OsEventTypeList.SCROLL_TOP_EVENT || et === OsEventTypeList.SCROLL_BOTTOM_EVENT
      log('info', 'listEvent', { eventType: et, isScroll, currentSelectItemIndex: event.listEvent.currentSelectItemIndex })
      if (!isScroll) {
        const index = event.listEvent.currentSelectItemIndex ?? 0
        const item = displayedRooms[index]
        if (item && !item.isHeader) {
          log('info', 'room selected', { id: item.id, name: item.name })
          navAbort?.abort()
          navAbort = new AbortController()
          const signal = navAbort.signal
          roomNavStartedAt = Date.now()
          const seq = ++navSeq
          selectedRoomId = item.id
          unreadRooms.delete(item.id)
          await showLoadingView(item.name)
          if (seq !== navSeq) return
          try {
            const result = await matrix.fetchHistory(item.id, 50, null, signal)
            if (seq !== navSeq) return
            navAbort = null
            seenEventIds = new Set(result.messages.map((m: MatrixMessage) => m.event_id).filter(Boolean))
            prevBatch = result.prevBatch
            // Reset and populate caches for the new room
            messageCache = new Map()
            reactions = new Map()
            currentRoomMessages = result.messages
            for (const m of result.messages) {
              if (m.event_id) messageCache.set(m.event_id, m)
            }
            // Merge reactions from history
            for (const { targetEventId, emoji } of (result.reactions ?? [])) {
              if (!reactions.has(targetEventId)) reactions.set(targetEventId, new Map())
              const rm = reactions.get(targetEventId)!
              rm.set(emoji, (rm.get(emoji) ?? 0) + 1)
            }
            await showMessageView(buildRoomLines(result.messages))
          } catch (err) {
            if ((err as any)?.name === 'AbortError') return
            log('error', 'fetchHistory failed', err)
            pushError('fetchHistory failed', String(err))
          }
        } else if (item?.isHeader) {
          log('info', 'section header tapped — ignoring', { name: item.name })
        } else {
          log('warn', 'listEvent index out of range', { index, displayedRoomsLength: displayedRooms.length })
        }
      }
    }
    if (event.sysEvent) {
      const et = event.sysEvent.eventType
      log('info', 'sysEvent', { eventType: et, view, msSinceListeningStart: Date.now() - listeningStartedAt })
      if (view === 'verification') {
        if (et === OsEventTypeList.CLICK_EVENT) {
          await confirmVerification()
        } else if (et === undefined) {
          await rejectVerification()
        }
        return
      } else if (view === 'listening' && recognizing && Date.now() - listeningStartedAt > 1000) {
        await stopAudio()
      } else if (view === 'loading') {
        if (et === undefined && Date.now() - roomNavStartedAt > 500) {
          await showRoomList()
        }
      } else if (view === 'messages') {
        if (et === OsEventTypeList.DOUBLE_CLICK_EVENT && whisperUrl) {
          await startAudio()
        } else if (et === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
          if (scrollOffset >= lines.length - SCROLL_STEP - 1 && prevBatch) {
            const prevCount = lines.length
            await loadMoreHistory()
            scrollOffset = Math.min(scrollOffset + (lines.length - prevCount), lines.length - 1)
          } else {
            scrollOffset = Math.min(scrollOffset + SCROLL_STEP, Math.max(0, lines.length - 1))
          }
          onUpdate?.()
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
          onUpdate?.()
          try {
            await bridge.textContainerUpgrade(new TextContainerUpgrade({
              containerID: CONTAINER_ID,
              content: buildContent(lines, scrollOffset),
            }))
          } catch (err) {
            log('error', 'textContainerUpgrade (scroll up) failed', err)
          }
        } else if (et === undefined) {
          if (Date.now() - roomNavStartedAt > 500) {
            log('info', 'back gesture (no eventType) → showRoomList')
            await showRoomList()
          } else {
            log('warn', 'back gesture ignored — within nav cooldown')
            onUpdate?.()
          }
        } else {
          log('warn', 'unhandled sysEvent in messages view', { eventType: et })
        }
      } else {
        log('warn', 'sysEvent unhandled in view', { view, eventType: et })
      }
    }
  }

  async function navigateToRoom(roomId: string) {
    const index = displayedRooms.findIndex(r => r.id === roomId && !r.isHeader)
    if (index !== -1) await handleEvenHubEvent({ listEvent: { currentSelectItemIndex: index } })
  }

  let lastSentText = ''
  let lastSentAt = 0
  const SEND_DEDUP_MS = 5000

  async function sendMessage(text: string) {
    if (!selectedRoomId || !text.trim()) return
    const now = Date.now()
    if (text.trim() === lastSentText && now - lastSentAt < SEND_DEDUP_MS) {
      log('info', 'sendMessage duplicate suppressed', { text: text.trim() })
      pushError('Message suppressed (sent too recently)')
      return
    }
    lastSentText = text.trim()
    lastSentAt = now
    try {
      await matrix.sendMessage(selectedRoomId, text.trim())
    } catch (err) {
      log('error', 'sendMessage failed', err)
      pushError('sendMessage failed', String(err))
    }
  }

  async function loadMoreHistory() {
    if (!selectedRoomId || !prevBatch) return
    if (loadingMore) return
    loadingMore = true
    try {
      await bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: CONTAINER_ID,
        content: 'Loading older messages...',
      }))
      const result = await matrix.fetchHistory(selectedRoomId, 50, prevBatch)
      result.messages.forEach(m => { if (m.event_id) { seenEventIds.add(m.event_id); messageCache.set(m.event_id, m) } })
      // Merge reactions from older history
      for (const { targetEventId, emoji } of (result.reactions ?? [])) {
        if (!reactions.has(targetEventId)) reactions.set(targetEventId, new Map())
        const rm = reactions.get(targetEventId)!
        rm.set(emoji, (rm.get(emoji) ?? 0) + 1)
      }
      currentRoomMessages = [...result.messages, ...currentRoomMessages]
      prevBatch = result.prevBatch
      const newLines = buildRoomLines(result.messages)
      const newMentions = buildMentionFlags(result.messages)
      lines = [...newLines, ...lines]
      mentions = [...newMentions, ...mentions]
    } catch (err) {
      log('error', 'loadMoreHistory failed', err)
      pushError('loadMoreHistory failed', String(err))
    } finally {
      loadingMore = false
      onUpdate?.()
      try {
        await bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: CONTAINER_ID,
          content: buildContent(lines, scrollOffset),
        }))
      } catch (err) {
        log('error', 'textContainerUpgrade (loadMore restore) failed', err)
      }
    }
  }

  function getState() {
    return { hierarchy, displayedRooms, selectedRoomId, lines, mentions, mentioned, view, loadingRoomName, transcribedText, recognizing, scrollOffset, matrixConnected, errors, syncToken, prevBatch, loadingMore, audioLevel, lastSyncAt, whisperConfigured: !!whisperUrl, audioBufBytes: audioBuf.reduce((n, c) => n + c.length, 0), audioMaxBytes: AUDIO_MAX_BYTES, unreadRooms: [...unreadRooms], verificationRequest, verificationEmoji }
  }

  return { start, showRoomList, showMessageView, appendLine, startAudio, stopAudio, handleEvenHubEvent, getState, sendMessage, navigateToRoom, loadMoreHistory, setupVerificationHandler, confirmVerification, rejectVerification }
}
