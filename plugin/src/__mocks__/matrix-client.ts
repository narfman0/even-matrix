import { vi } from 'vitest'
import type { RoomHierarchy } from '../matrix-client'

export function makeFakeMatrixClient() {
  let onMessageCb: ((roomId: string, eventId: string, sender: string, text: string) => void) | null = null
  let onTokenCb: ((token: string) => void) | null = null

  return {
    listRoomsHierarchical: vi.fn<[], Promise<RoomHierarchy>>().mockResolvedValue({ dms: [], spaces: [], orphans: [] }),
    fetchHistory: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    startSyncLoop: vi.fn((
      _since: string | null,
      onMsg: (roomId: string, eventId: string, sender: string, text: string) => void,
      onToken: (token: string) => void
    ) => {
      onMessageCb = onMsg
      onTokenCb = onToken
    }),
    stopSyncLoop: vi.fn(),

    async triggerSyncMessage(roomId: string, eventId: string, sender: string, text: string) {
      await onMessageCb?.(roomId, eventId, sender, text)
    },
    triggerSyncToken(token: string) {
      onTokenCb?.(token)
    },
  }
}

export type FakeMatrixClient = ReturnType<typeof makeFakeMatrixClient>
