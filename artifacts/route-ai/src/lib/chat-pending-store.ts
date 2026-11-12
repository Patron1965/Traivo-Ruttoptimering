import { useSyncExternalStore } from "react";
import type { PendingChatMessage } from "./chat-display";

/**
 * Module-level pending-send evidence. Survives scope switches and panel
 * unmounts within the session so an in-flight or failed send is never silently
 * discarded. Entries are keyed by actor+scope (see scopeKey) and by stable
 * clientMessageId, so a late response can only touch its own entry.
 */
let state: PendingChatMessage[] = [];
const listeners = new Set<() => void>();

export function getPendingChat(): PendingChatMessage[] {
  return state;
}

export function updatePendingChat(fn: (cur: PendingChatMessage[]) => PendingChatMessage[]) {
  const next = fn(state);
  if (next === state) return;
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingChat(): PendingChatMessage[] {
  return useSyncExternalStore(subscribe, getPendingChat, getPendingChat);
}
