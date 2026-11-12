import { workspaceToken } from "./workspace-context";
type MessageHandler = (data: unknown) => void;

const listeners = new Map<string, Set<MessageHandler>>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let organizationId: string | null = null;
let predictionsSubscribed = false;
let connectionGeneration = 0;
const RECONNECT_DELAY = 3000;

function getWsUrl(): string {
  const url = new URL(`${import.meta.env?.BASE_URL ?? "/"}api/ws`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function sendPendingSubscriptions(socket: WebSocket) {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (predictionsSubscribed) socket.send(JSON.stringify({ type: "subscribe-predictions" }));
}

function connect() {
  if (!organizationId || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) {
    return;
  }

  const connectionOrgId = organizationId;
  const generation = connectionGeneration;
  try {
    const socket = new WebSocket(getWsUrl(), workspaceToken ? [`workspace.${workspaceToken}`] : []);
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket || generation !== connectionGeneration || organizationId !== connectionOrgId) return;
      socket.send(JSON.stringify({ type: "subscribe", organizationId: connectionOrgId }));
      sendPendingSubscriptions(socket);
    };

    socket.onmessage = (event) => {
      // A queued event from an old tenant/socket must never reach current query listeners.
      if (ws !== socket || generation !== connectionGeneration || organizationId !== connectionOrgId) return;
      try {
        const msg = JSON.parse(event.data);
        const handlers = listeners.get(msg.type);
        if (handlers) for (const handler of handlers) handler(msg.data);
      } catch {}
    };

    socket.onclose = () => {
      if (ws !== socket || generation !== connectionGeneration) return;
      ws = null;
      scheduleReconnect();
    };

    socket.onerror = () => socket.close();
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!organizationId || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY);
}

/**
 * Explicitly ends the authenticated websocket lifecycle. Supplying an org only
 * tears down that org's connection, which makes React effect cleanup safe.
 */
export function resetWsClient(expectedOrganizationId?: string) {
  if (expectedOrganizationId && organizationId !== expectedOrganizationId) return;
  connectionGeneration++;
  organizationId = null;
  predictionsSubscribed = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const socket = ws;
  ws = null;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    socket.close(1000, "Authentication changed");
  }
}

export function initWsClient(orgId: string) {
  if (organizationId && organizationId !== orgId) resetWsClient();
  organizationId = orgId;
  connect();
}

export function ensureWsInitialized(orgId: string) {
  if (organizationId !== orgId) initWsClient(orgId);
}

export function onWsMessage(type: string, handler: MessageHandler): () => void {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)!.add(handler);
  return () => listeners.get(type)?.delete(handler);
}

export function subscribePredictions() {
  predictionsSubscribed = true;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "subscribe-predictions" }));
}

export function unsubscribePredictions() {
  predictionsSubscribed = false;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "unsubscribe-predictions" }));
}

export function isWsConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}