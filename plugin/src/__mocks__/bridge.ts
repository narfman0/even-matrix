import { vi } from 'vitest'

export function makeMockBridge() {
  return {
    rebuildPageContainer: vi.fn().mockResolvedValue(undefined),
    textContainerUpgrade: vi.fn().mockResolvedValue(undefined),
  }
}
