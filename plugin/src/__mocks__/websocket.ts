export class FakeWebSocket {
  static OPEN = 1
  readyState = FakeWebSocket.OPEN
  sent: string[] = []
  sentBinary: Uint8Array[] = []
  onopen: (() => void | Promise<void>) | null = null
  onmessage: ((e: MessageEvent) => void | Promise<void>) | null = null
  onclose: ((e: CloseEvent) => void | Promise<void>) | null = null
  onerror: ((e: Event) => void | Promise<void>) | null = null

  send(data: string | ArrayBufferLike | ArrayBufferView) {
    if (typeof data === 'string') {
      this.sent.push(data)
    } else {
      this.sentBinary.push(new Uint8Array(data as ArrayBufferLike))
    }
  }

  async triggerOpen() { await this.onopen?.() }

  async triggerMessage(data: object): Promise<void> {
    await this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }

  async triggerClose(code = 1000, reason = ''): Promise<void> {
    await this.onclose?.({ code, reason } as CloseEvent)
  }
}
