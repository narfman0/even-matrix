import { vi } from 'vitest'
import type { RoomHierarchy } from '../matrix-client'

export function makeFakeMatrixClient() {
  let onMessageCb: ((roomId: string, eventId: string, sender: string, text: string, replyTo?: string) => void) | null = null
  let onTokenCb: ((token: string) => void) | null = null
  let onReactionCb: ((roomId: string, targetEventId: string, emoji: string) => void) | null = null

  return {
    initialSync: vi.fn().mockResolvedValue({ hierarchy: { dms: [], spaces: [], orphans: [] }, nextBatch: 'batch-0' }),
    fetchHistory: vi.fn().mockResolvedValue({ messages: [], prevBatch: null, reactions: [] }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    startSyncLoop: vi.fn((
      _since: string,
      onMsg: (roomId: string, eventId: string, sender: string, text: string, replyTo?: string) => void,
      onToken: (token: string) => void,
      onReaction?: (roomId: string, targetEventId: string, emoji: string) => void
    ) => {
      onMessageCb = onMsg
      onTokenCb = onToken
      onReactionCb = onReaction ?? null
    }),
    stopSyncLoop: vi.fn(),

    async triggerSyncMessage(roomId: string, eventId: string, sender: string, text: string, replyTo?: string) {
      await onMessageCb?.(roomId, eventId, sender, text, replyTo)
    },
    triggerSyncToken(token: string) {
      onTokenCb?.(token)
    },
    async triggerReaction(roomId: string, targetEventId: string, emoji: string) {
      await onReactionCb?.(roomId, targetEventId, emoji)
    },
  }
}

export type FakeMatrixClient = ReturnType<typeof makeFakeMatrixClient>
