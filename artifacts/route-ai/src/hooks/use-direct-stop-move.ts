import { useCallback, useSyncExternalStore } from "react";
import { useAuth } from "@/lib/auth-context";

const CHANGE_EVENT = "traivo:direct-stop-move-preference";
// A failed write must never leave direct moves enabled in another hook instance.
const failedKeys = new Set<string>();
const serverSnapshot = () => false;

/**
 * Browser-local opt-in, isolated by the authenticated user and active organization.
 * setEnabled returns false when the preference could not be persisted.
 */
export function useDirectStopMove(): {
  enabled: boolean;
  setEnabled: (enabled: boolean) => boolean;
} {
  const { user, isLoading, isLoggingOut } = useAuth();
  const key = !isLoading && !isLoggingOut && user?.id && user.organizationId
    ? `traivo:direct-stop-move:v1:${JSON.stringify([user.organizationId, user.id])}`
    : null;

  const getSnapshot = useCallback(() => {
    if (!key || typeof window === "undefined" || failedKeys.has(key)) return false;
    try {
      // Only an explicit, valid opt-in enables direct moves.
      return window.localStorage.getItem(key) === "true";
    } catch {
      return false;
    }
  }, [key]);

  const subscribe = useCallback((onChange: () => void) => {
    if (!key || typeof window === "undefined") return () => {};
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== key) return;
      try {
        if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
      } catch {
        onChange();
        return;
      }
      failedKeys.delete(key);
      onChange();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, [key]);

  const enabled = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);

  const setEnabled = useCallback((nextEnabled: boolean): boolean => {
    if (!key || typeof window === "undefined") return false;
    let saved = false;
    try {
      window.localStorage.setItem(key, nextEnabled === true ? "true" : "false");
      failedKeys.delete(key);
      saved = true;
    } catch {
      failedKeys.add(key);
    }
    // The native storage event is only emitted in other tabs.
    window.dispatchEvent(new Event(CHANGE_EVENT));
    return saved;
  }, [key]);

  return { enabled, setEnabled };
}
