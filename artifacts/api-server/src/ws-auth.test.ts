import assert from "node:assert/strict";
import { test } from "node:test";
import {
  enqueuePendingAuthMessage,
  getWebSocketSessionToken,
  MAX_PENDING_AUTH_BYTES,
  MAX_PENDING_AUTH_MESSAGES,
  sendTenantEvent,
  type WsClient,
} from "./ws";

test("websocket bearer tokens take precedence over cookies", () => {
  assert.equal(
    getWebSocketSessionToken({
      authorization: "Bearer expo-token",
      cookie: "routeai_session=browser-token",
    }),
    "expo-token",
  );
});

test("websocket accepts the same-origin session cookie", () => {
  assert.equal(
    getWebSocketSessionToken({ cookie: "theme=dark; routeai_session=browser-token; other=value" }),
    "browser-token",
  );
});

test("websocket does not accept missing or malformed credentials", () => {
  assert.equal(getWebSocketSessionToken({}), null);
  assert.equal(getWebSocketSessionToken({ authorization: "Basic credentials" }), null);
});

test("a revoked websocket session is closed before a tenant event is sent", async () => {
  let sent = 0;
  let closed = 0;
  const socket = {
    readyState: 1,
    send: () => { sent++; },
    close: () => { closed++; },
  };
  const client = {
    ws: socket,
    sessionId: "session-a",
    sessionToken: "token-a",
    userId: "user-a",
    organizationId: "tenant-a",
  } as unknown as WsClient;

  await sendTenantEvent(client, "tenant-event", async () => false);

  assert.equal(sent, 0);
  assert.equal(closed, 1);
});

test("websocket pre-authentication messages are bounded by count and bytes", () => {
  const messages: Buffer[] = [];
  let bytes = 0;
  for (let index = 0; index < MAX_PENDING_AUTH_MESSAGES; index += 1) {
    const nextBytes = enqueuePendingAuthMessage(messages, Buffer.from("x"), bytes);
    assert.notEqual(nextBytes, null);
    bytes = nextBytes!;
  }

  assert.equal(
    enqueuePendingAuthMessage(messages, Buffer.from("overflow"), bytes),
    null,
  );
  assert.equal(messages.length, MAX_PENDING_AUTH_MESSAGES);

  const oversizedMessages: Buffer[] = [];
  assert.equal(
    enqueuePendingAuthMessage(
      oversizedMessages,
      Buffer.alloc(MAX_PENDING_AUTH_BYTES + 1),
      0,
    ),
    null,
  );
  assert.equal(oversizedMessages.length, 0);
});