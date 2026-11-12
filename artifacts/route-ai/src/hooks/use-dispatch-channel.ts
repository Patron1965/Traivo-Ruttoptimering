import { useEffect, useRef, useCallback } from "react";
import { useSearch } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { acceptsDispatchScope, dispatchChannelScope } from "@/lib/dispatch-channel-scope";

const CHANNEL_NAME = "traivo-dispatch-map";

export interface DispatchChannelMessage {
  type: "hover" | "select" | "highlight" | "route-selection" | "focus" | "ping" | "pong" | "close";
  stopId?: string | null;
  routeId?: string | null;
  routeIds?: string[];
  scopeKey?: string;
  from: "main" | "popout";
  ts: number;
}

export function useDispatchChannel(
  from: "main" | "popout",
  onMessage: (msg: DispatchChannelMessage) => void,
  peerWindow?: () => Window | null,
) {
  const { user } = useAuth();
  const search = useSearch();
  const scopeRef = useRef("");
  scopeRef.current = dispatchChannelScope(`${user?.organizationId ?? ""}:${user?.id ?? ""}`, search);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const onMessageRef = useRef(onMessage);
  const peerRef = useRef(peerWindow);
  peerRef.current = peerWindow;
  const direct = Boolean(peerWindow);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    let removeDirectListener = () => {};
    if (direct) {
      const handler = (event: MessageEvent) => {
        if (event.origin !== window.location.origin || !peerRef.current?.() ||
            event.source !== peerRef.current()) return;
        if (event.data?.channel !== CHANNEL_NAME || !event.data.message ||
            event.data.message.from === from) return;
        if (!acceptsDispatchScope(scopeRef.current, event.data.message.scopeKey)) return;
        onMessageRef.current(event.data.message);
      };
      window.addEventListener("message", handler);
      removeDirectListener = () => window.removeEventListener("message", handler);
      if (from === "popout") return removeDirectListener;
    }
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
      return removeDirectListener;
    }
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;
    const handler = (event: MessageEvent<DispatchChannelMessage>) => {
      if (event.data?.from === from || event.data?.type === "route-selection") return;
      if (!acceptsDispatchScope(scopeRef.current, event.data?.scopeKey)) return;
      // Legacy timeline broadcasts must not change the map window's lifecycle.
      if (direct && ["pong", "close", "highlight"].includes(event.data?.type)) return;
      onMessageRef.current(event.data);
    };
    channel.addEventListener("message", handler);
    return () => {
      removeDirectListener();
      channel.removeEventListener("message", handler);
      channel.close();
      channelRef.current = null;
    };
  }, [from, direct]);

  const send = useCallback(
    (msg: Omit<DispatchChannelMessage, "from" | "ts">) => {
      if (direct) {
        const peer = peerRef.current?.();
        if (peer && !peer.closed) peer.postMessage({
          channel: CHANNEL_NAME, message: { ...msg, scopeKey: scopeRef.current, from, ts: Date.now() },
        }, window.location.origin);
        if (from === "popout") return;
      }
      // Multi-route selections are private to the exact opener/map pair.
      if (msg.type === "route-selection") return;
      const channel = channelRef.current;
      if (!channel) return;
      channel.postMessage({ ...msg, scopeKey: scopeRef.current, from, ts: Date.now() });
    },
    [from, direct],
  );

  return { send };
}
