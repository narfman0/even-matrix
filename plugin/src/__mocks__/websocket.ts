export class FakeWebSocket {
  static OPEN = 1
  readyState = FakeWebSocket.OPEN
  sent: string[] = []
  onopen: (() => void | Promise<void>) | null = null
  onmessage: ((e: MessageEvent) => void | Promise<void>) | null = null
  onclose: (() => void | Promise<void>) | null = null

  send(data: string) { this.sent.push(data) }

  async triggerOpen() { await this.onopen?.() }

  async triggerMessage(data: object): Promise<void> {
    await this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }

  async triggerClose(): Promise<void> { await this.onclose?.() }
}
