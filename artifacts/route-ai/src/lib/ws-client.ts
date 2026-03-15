type MessageHandler = (data: unknown) => void;

const listeners = new Map<string, Set<MessageHandler>>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let organizationId: string | null = null;
let predictionsSubscribed = false;
const RECONNECT_DELAY = 3000;

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

function sendPendingSubscriptions() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (predictionsSubscribed) {
    ws.send(JSON.stringify({ type: "subscribe-predictions" }));
  }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(getWsUrl());

    ws.onopen = () => {
      if (organizationId) {
        ws?.send(JSON.stringify({ type: "subscribe", organizationId }));
      }
      sendPendingSubscriptions();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const handlers = listeners.get(msg.type);
        if (handlers) {
          for (const handler of handlers) {
            handler(msg.data);
          }
        }
      } catch {}
    };

    ws.onclose = () => {
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws?.close();
    };
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY);
}

export function initWsClient(orgId: string) {
  organizationId = orgId;
  connect();
}

export function ensureWsInitialized(orgId: string) {
  if (!organizationId) {
    initWsClient(orgId);
  }
}

export function onWsMessage(type: string, handler: MessageHandler): () => void {
  if (!listeners.has(type)) {
    listeners.set(type, new Set());
  }
  listeners.get(type)!.add(handler);

  return () => {
    listeners.get(type)?.delete(handler);
  };
}

export function subscribePredictions() {
  predictionsSubscribed = true;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "subscribe-predictions" }));
  }
}

export function unsubscribePredictions() {
  predictionsSubscribed = false;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "unsubscribe-predictions" }));
  }
}

export function isWsConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}
