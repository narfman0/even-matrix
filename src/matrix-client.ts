export interface RoomInfo { id: string; name: string }
export interface SpaceInfo { id: string; name: string; rooms: RoomInfo[] }
export interface RoomHierarchy { dms: RoomInfo[]; spaces: SpaceInfo[]; orphans: RoomInfo[] }

export interface MatrixMessage {
  event_id: string
  sender: string
  text: string
  ts: number
}

export interface MatrixClient {
  initialSync(): Promise<{ hierarchy: RoomHierarchy; nextBatch: string }>
  fetchHistory(roomId: string, limit: number, signal?: AbortSignal): Promise<MatrixMessage[]>
  sendMessage(roomId: string, text: string): Promise<void>
  startSyncLoop(
    since: string,
    onMessage: (roomId: string, eventId: string, sender: string, text: string) => void,
    onSyncToken: (token: string) => void
  ): void
  stopSyncLoop(): void
}

export class MatrixRestClient implements MatrixClient {
  private homeserver: string
  private accessToken: string
  private userId: string
  private stopSync = false
  private abortController: AbortController | null = null

  constructor(homeserver: string, accessToken: string, userId: string) {
    this.homeserver = homeserver.replace(/\/$/, '')
    this.accessToken = accessToken
    this.userId = userId
  }

  private authHeaders(): HeadersInit {
    return { 'Authorization': `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' }
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.homeserver}${path}`, { headers: this.authHeaders(), signal })
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`)
    return res.json()
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.homeserver}${path}`, {
      method: 'PUT',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`PUT ${path}: ${res.status}`)
    return res.json()
  }

  static async login(homeserver: string, username: string, password: string) {
    const hs = homeserver.replace(/\/$/, '')
    const res = await fetch(`${hs}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
    return res.json() as Promise<{ access_token: string; device_id: string; user_id: string }>
  }

  async initialSync(): Promise<{ hierarchy: RoomHierarchy; nextBatch: string }> {
    const filter = encodeURIComponent(JSON.stringify({
      room: {
        state: { types: ['m.room.name', 'm.room.create', 'm.space.child', 'm.room.member'] },
        timeline: { limit: 0 },
        ephemeral: { limit: 0 },
        account_data: { limit: 0 },
      },
      account_data: { limit: 0 },
      presence: { limit: 0 },
    }))
    const data = await this.get<any>(`/_matrix/client/v3/sync?timeout=0&filter=${filter}`)
    const nextBatch: string = data.next_batch

    const dms: RoomInfo[] = []
    const spacesMap = new Map<string, SpaceInfo>()
    const spaceChildren = new Map<string, string[]>()
    const nonSpaceRooms: RoomInfo[] = []

    for (const [roomId, roomData] of Object.entries(data.rooms?.join ?? {} as Record<string, any>)) {
      const stateEvents: any[] = (roomData as any).state?.events ?? []

      const nameEvent = stateEvents.find(e => e.type === 'm.room.name' && e.state_key === '')
      const createEvent = stateEvents.find(e => e.type === 'm.room.create' && e.state_key === '')
      const memberEvent = stateEvents.find(e =>
        e.type === 'm.room.member' &&
        e.state_key === this.userId &&
        e.content?.is_direct === true
      )
      const childEvents = stateEvents.filter(e => e.type === 'm.space.child' && e.content?.via)

      const name: string = nameEvent?.content?.name ?? roomId
      const isSpace = createEvent?.content?.type === 'm.space'
      const isDM = !!memberEvent

      if (isSpace) {
        spacesMap.set(roomId, { id: roomId, name, rooms: [] })
        spaceChildren.set(roomId, childEvents.map((e: any) => e.state_key as string))
      } else {
        nonSpaceRooms.push({ id: roomId, name })
        if (isDM) dms.push({ id: roomId, name })
      }
    }

    const childIds = new Set([...spaceChildren.values()].flat())
    const dmIds = new Set(dms.map(d => d.id))
    const orphans = nonSpaceRooms.filter(r => !dmIds.has(r.id) && !childIds.has(r.id))

    const spaces: SpaceInfo[] = []
    for (const [spaceId, space] of spacesMap) {
      const children = (spaceChildren.get(spaceId) ?? [])
        .map(id => nonSpaceRooms.find(r => r.id === id))
        .filter((r): r is RoomInfo => !!r)
      spaces.push({ ...space, rooms: children })
    }

    return { hierarchy: { dms, spaces, orphans }, nextBatch }
  }

  async fetchHistory(roomId: string, limit: number, signal?: AbortSignal): Promise<MatrixMessage[]> {
    const data = await this.get<{ chunk: any[] }>(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`,
      signal
    )
    const msgs: MatrixMessage[] = []
    for (const event of data.chunk) {
      if (event.type !== 'm.room.message') continue
      if (event.content?.msgtype !== 'm.text') continue
      msgs.push({
        event_id: event.event_id,
        sender: this.displaySender(event.sender),
        text: event.content.body,
        ts: Math.floor(event.origin_server_ts / 1000),
      })
    }
    msgs.reverse()
    return msgs
  }

  async sendMessage(roomId: string, text: string): Promise<void> {
    const txnId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
    })
    await this.put(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      { msgtype: 'm.text', body: text }
    )
  }

  startSyncLoop(
    since: string,
    onMessage: (roomId: string, eventId: string, sender: string, text: string) => void,
    onSyncToken: (token: string) => void
  ): void {
    this.stopSync = false
    void this.runSyncLoop(since, onMessage, onSyncToken)
  }

  private async runSyncLoop(
    since: string,
    onMessage: (roomId: string, eventId: string, sender: string, text: string) => void,
    onSyncToken: (token: string) => void
  ): Promise<void> {
    while (!this.stopSync) {
      try {
        this.abortController = new AbortController()
        const params = new URLSearchParams({ timeout: '30000', since })
        const res = await fetch(`${this.homeserver}/_matrix/client/v3/sync?${params}`, {
          headers: this.authHeaders(),
          signal: this.abortController.signal,
        })
        if (!res.ok) throw new Error(`sync: ${res.status}`)
        const data: any = await res.json()
        since = data.next_batch as string
        onSyncToken(since)

        if (data.rooms?.join) {
          for (const [roomId, roomData] of Object.entries(data.rooms.join as Record<string, any>)) {
            for (const event of (roomData.timeline?.events ?? [])) {
              if (event.type !== 'm.room.message') continue
              if (event.content?.msgtype !== 'm.text') continue
              await onMessage(roomId, event.event_id, this.displaySender(event.sender), event.content.body)
            }
          }
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') return
        await new Promise(r => setTimeout(r, 5000))
      }
    }
  }

  stopSyncLoop(): void {
    this.stopSync = true
    this.abortController?.abort()
  }

  displaySender(userId: string): string {
    try {
      const hs = new URL(this.homeserver).hostname
      const withoutAt = userId.startsWith('@') ? userId.slice(1) : userId
      const colon = withoutAt.indexOf(':')
      if (colon === -1) return userId
      const local = withoutAt.slice(0, colon)
      const server = withoutAt.slice(colon + 1)
      return server === hs ? local : `${local}@${server}`
    } catch {
      return userId
    }
  }
}
