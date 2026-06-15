import {
  createClient,
  ClientEvent,
  RoomEvent,
  Direction,
  MatrixEventEvent,
  SyncState,
} from 'matrix-js-sdk'
import type { MatrixClient as SdkMatrixClient } from 'matrix-js-sdk'
import type { MatrixClient, MatrixMessage, RoomHierarchy, RoomInfo } from './matrix-client'

export class MatrixSdkClient implements MatrixClient {
  private client: SdkMatrixClient
  private running = false

  constructor(homeserver: string, accessToken: string, userId: string, deviceId: string) {
    this.client = createClient({
      baseUrl: homeserver,
      accessToken,
      userId,
      deviceId: deviceId || undefined,
    })
  }

  async initialSync(): Promise<{ hierarchy: RoomHierarchy; nextBatch: string }> {
    try {
      await this.client.initRustCrypto()
    } catch (err) {
      console.warn('[even-matrix] initRustCrypto failed:', err)
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('initialSync timeout')), 30000)
      this.client.once(ClientEvent.Sync, (state: SyncState) => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) {
          clearTimeout(timeout)
          resolve()
        }
      })
      this.client.startClient({ initialSyncLimit: 30 }).catch(reject)
    })

    const nextBatch = this.client.getSyncStateData()?.nextSyncToken ?? ''
    const hierarchy = this._buildHierarchy()
    return { hierarchy, nextBatch }
  }

  private _buildHierarchy(): RoomHierarchy {
    const rooms = this.client.getVisibleRooms()
    // DM detection: m.direct account data maps userId → [roomId, ...]
    const dmData = (this.client.getAccountData('m.direct')?.getContent() ?? {}) as Record<string, string[]>
    const dmRoomIds = new Set<string>(Object.values(dmData).flat())

    const dms: RoomInfo[] = []
    const spaces: Array<{ id: string; name: string; rooms: RoomInfo[] }> = []
    const orphans: RoomInfo[] = []
    const spaceChildIds = new Set<string>()

    for (const room of rooms) {
      if (room.isSpaceRoom()) {
        const childRooms: RoomInfo[] = []
        const childEvents = room.currentState.getStateEvents('m.space.child')
        for (const ev of childEvents) {
          const childId = ev.getStateKey()
          if (childId) {
            spaceChildIds.add(childId)
            const childRoom = this.client.getRoom(childId)
            if (childRoom) childRooms.push({ id: childId, name: childRoom.name })
          }
        }
        spaces.push({ id: room.roomId, name: room.name, rooms: childRooms })
      }
    }

    for (const room of rooms) {
      if (room.isSpaceRoom()) continue
      const info: RoomInfo = { id: room.roomId, name: room.name }
      if (dmRoomIds.has(room.roomId)) {
        dms.push(info)
      } else if (!spaceChildIds.has(room.roomId)) {
        orphans.push(info)
      }
    }

    return { dms, spaces, orphans }
  }

  async fetchHistory(roomId: string, limit: number, from: string | null, signal?: AbortSignal): Promise<{ messages: MatrixMessage[]; prevBatch: string | null; reactions: Array<{ targetEventId: string; emoji: string }> }> {
    const room = this.client.getRoom(roomId)
    if (!room) return { messages: [], prevBatch: null, reactions: [] }

    const token = from ?? room.getLiveTimeline().getPaginationToken(Direction.Backward) ?? null
    const res = await this.client.createMessagesRequest(
      roomId,
      token,
      limit,
      Direction.Backward,
    )

    const messages: MatrixMessage[] = []
    const reactions: Array<{ targetEventId: string; emoji: string }> = []
    for (const ev of ([...(res.chunk ?? [])]).reverse()) {
      const type = ev.type
      if (type === 'm.reaction') {
        const rel = ev.content?.['m.relates_to']
        if (rel?.rel_type === 'm.annotation' && rel.event_id && rel.key) {
          reactions.push({ targetEventId: rel.event_id, emoji: rel.key })
        }
        continue
      }
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') continue
      const content = ev.content
      if (!content) continue
      const relatesTo = content['m.relates_to']
      const inReplyTo = relatesTo?.['m.in_reply_to']?.event_id as string | undefined
      let text: string
      if (content.msgtype === 'm.text') {
        let body = content.body as string
        if (inReplyTo) {
          const parts = body.split('\n\n')
          if (parts.length >= 2 && parts[0].startsWith('> ')) {
            body = parts.slice(1).join('\n\n')
          }
        }
        text = body
      } else if (content.msgtype === 'm.image') {
        text = '[image]'
      } else if (content.msgtype === 'm.video') {
        text = '[video]'
      } else if (content.msgtype === 'm.audio') {
        text = '[audio]'
      } else if (content.msgtype === 'm.file') {
        text = `[file: ${content.body ?? 'file'}]`
      } else if (content.msgtype === 'm.sticker') {
        text = '[sticker]'
      } else {
        continue
      }
      messages.push({
        event_id: ev.event_id ?? '',
        sender: this._displaySender(ev.sender ?? ''),
        text,
        ts: Math.floor((ev.origin_server_ts ?? 0) / 1000),
        replyTo: inReplyTo,
      })
    }

    return { messages, prevBatch: res.end ?? null, reactions }
  }

  async sendMessage(roomId: string, text: string): Promise<void> {
    await this.client.sendTextMessage(roomId, text)
  }

  startSyncLoop(
    since: string,
    onMessage: (roomId: string, eventId: string, sender: string, text: string, replyTo?: string) => void,
    onSyncToken: (token: string) => void,
    onReaction?: (roomId: string, targetEventId: string, emoji: string) => void
  ): void {
    this.running = true
    this.client.on(RoomEvent.Timeline, async (event, room) => {
      if (!this.running) return
      if (!room) return

      if (event.isEncrypted() && !event.getClearContent()) {
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('decrypt timeout')), 5000)
            event.once(MatrixEventEvent.Decrypted, () => { clearTimeout(timeout); resolve() })
          })
        } catch {
          return
        }
      }

      const type = event.getType()

      if (type === 'm.reaction') {
        const rel = event.getContent()?.['m.relates_to']
        if (rel?.rel_type === 'm.annotation' && onReaction) {
          onReaction(room.roomId, rel.event_id, rel.key)
        }
        return
      }

      if (type !== 'm.room.message') return
      const content = event.getContent()
      const relatesTo = content?.['m.relates_to']
      const replyTo = relatesTo?.['m.in_reply_to']?.event_id as string | undefined
      let text: string
      if (content?.msgtype === 'm.text') {
        let body: string = content.body ?? ''
        if (replyTo) {
          const parts = body.split('\n\n')
          if (parts.length >= 2 && parts[0].startsWith('> ')) {
            body = parts.slice(1).join('\n\n')
          }
        }
        text = body
      } else if (content?.msgtype === 'm.image') {
        text = '[image]'
      } else if (content?.msgtype === 'm.video') {
        text = '[video]'
      } else if (content?.msgtype === 'm.audio') {
        text = '[audio]'
      } else if (content?.msgtype === 'm.file') {
        text = `[file: ${content.body ?? 'file'}]`
      } else if (content?.msgtype === 'm.sticker') {
        text = '[sticker]'
      } else {
        return
      }

      const newToken = this.client.getSyncStateData()?.nextSyncToken
      if (newToken) onSyncToken(newToken)
      await onMessage(
        room.roomId,
        event.getId() ?? '',
        this._displaySender(event.getSender() ?? ''),
        text,
        replyTo
      )
    })

    this.client.on(ClientEvent.Sync, (_state, _prev, data) => {
      const token = data?.nextSyncToken ?? this.client.getSyncStateData()?.nextSyncToken
      if (token) onSyncToken(token)
    })
  }

  stopSyncLoop(): void {
    this.running = false
    this.client.stopClient()
  }

  private _displaySender(userId: string): string {
    const room = this.client.getRooms().find(r =>
      r.getMember(userId)?.name && r.getMember(userId)!.name !== userId
    )
    return room?.getMember(userId)?.name ?? userId.replace(/@([^:]+):.*/, '$1')
  }
}
