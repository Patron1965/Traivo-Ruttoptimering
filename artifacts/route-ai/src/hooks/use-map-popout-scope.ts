import { useEffect, type RefObject } from "react";
import { mapPopoutHref } from "@/lib/dispatch-scope";

/** Send only to this dispatch window's map, including after the map reloads. */
export function useMapPopoutScope(search: string, popupRef: RefObject<Window | null>) {
  const href = mapPopoutHref(search, import.meta.env.BASE_URL);
  useEffect(() => {
    const sync = () => {
      const popup = popupRef.current;
      if (popup && !popup.closed) popup.postMessage({
        type: "traivo-map-scope",
        search: new URL(href, window.location.origin).search,
      }, window.location.origin);
    };
    const ready = (event: MessageEvent) => {
      if (event.origin === window.location.origin && popupRef.current &&
          event.source === popupRef.current && event.data?.type === "traivo-map-ready") sync();
    };
    window.addEventListener("message", ready);
    sync();
    return () => window.removeEventListener("message", ready);
  }, [href, popupRef]);
  return href;
}