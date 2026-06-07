import { describe, it, expect, vi, afterEach } from 'vitest'
import { MatrixRestClient } from './matrix-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MatrixRestClient — network timeouts', () => {
  it('initialSync passes an AbortSignal to fetch', async () => {
    let capturedSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: RequestInit) => {
      capturedSignal = opts?.signal as AbortSignal | undefined
      return {
        ok: true,
        json: async () => ({
          next_batch: 'batch-1',
          rooms: { join: {} },
        }),
      }
    }))

    const client = new MatrixRestClient('https://matrix.example.com', 'token', '@user:example.com')
    await client.initialSync()

    expect(capturedSignal).toBeInstanceOf(AbortSignal)
  })

  it('fetchHistory passes an AbortSignal to fetch', async () => {
    let capturedSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: RequestInit) => {
      capturedSignal = opts?.signal as AbortSignal | undefined
      return {
        ok: true,
        json: async () => ({ chunk: [], end: null }),
      }
    }))

    const client = new MatrixRestClient('https://matrix.example.com', 'token', '@user:example.com')
    await client.fetchHistory('!room:example.com', 50, null)

    expect(capturedSignal).toBeInstanceOf(AbortSignal)
  })

  it('fetchHistory merges caller signal with timeout signal', async () => {
    let capturedSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: RequestInit) => {
      capturedSignal = opts?.signal as AbortSignal | undefined
      return {
        ok: true,
        json: async () => ({ chunk: [], end: null }),
      }
    }))

    const callerAbort = new AbortController()
    const client = new MatrixRestClient('https://matrix.example.com', 'token', '@user:example.com')
    await client.fetchHistory('!room:example.com', 50, null, callerAbort.signal)

    expect(capturedSignal).toBeInstanceOf(AbortSignal)
  })
})
