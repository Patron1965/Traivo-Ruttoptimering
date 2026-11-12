import assert from "node:assert/strict";
import { test } from "node:test";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
}

test("switching tenant resets the old socket and drops its queued events", async () => {
  Object.assign(globalThis, {
    WebSocket: MockWebSocket,
    window: { location: { origin: "http://localhost" } },
  });
  const { initWsClient, onWsMessage, resetWsClient } = await import("./ws-client");
  const received: unknown[] = [];
  const unsubscribe = onWsMessage("data:route:updated", (data) => received.push(data));

  initWsClient("tenant-a");
  const socketA = MockWebSocket.instances[0];
  socketA.readyState = MockWebSocket.OPEN;
  socketA.onopen?.();

  initWsClient("tenant-b");
  const socketB = MockWebSocket.instances[1];
  socketB.readyState = MockWebSocket.OPEN;
  socketB.onopen?.();
  socketA.onmessage?.({ data: JSON.stringify({ type: "data:route:updated", data: { id: "a-route" } }) });

  assert.equal(socketA.closed, true);
  assert.deepEqual(received, []);
  assert.deepEqual(JSON.parse(socketB.sent[0]), { type: "subscribe", organizationId: "tenant-b" });

  unsubscribe();
  resetWsClient();
});