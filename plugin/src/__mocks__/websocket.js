export class FakeWebSocket {
    constructor() {
        this.readyState = FakeWebSocket.OPEN;
        this.sent = [];
        this.sentBinary = [];
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
    }
    send(data) {
        if (typeof data === 'string') {
            this.sent.push(data);
        }
        else {
            this.sentBinary.push(new Uint8Array(data));
        }
    }
    async triggerOpen() { await this.onopen?.(); }
    async triggerMessage(data) {
        await this.onmessage?.({ data: JSON.stringify(data) });
    }
    async triggerClose(code = 1000, reason = '') {
        await this.onclose?.({ code, reason });
    }
}
FakeWebSocket.OPEN = 1;
