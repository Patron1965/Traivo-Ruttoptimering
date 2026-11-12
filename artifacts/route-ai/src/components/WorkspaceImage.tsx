import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { workspaceToken } from "@/lib/workspace-context";

/** Private image elements cannot send authorization headers themselves. */
export function WorkspaceImage({ src, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const [blob, setBlob] = useState<string>();
  const [error, setError] = useState(false);
  const protectedImage = Boolean(workspaceToken && src &&
    new URL(src, window.location.href).origin === window.location.origin &&
    new URL(src, window.location.href).pathname.startsWith("/api/"));
  useEffect(() => {
    setBlob(undefined); setError(false);
    if (!protectedImage || !src) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void fetch(src, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Image access denied");
      const image = await response.blob();
      if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(image); setBlob(objectUrl); }
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, protectedImage]);
  if (error) return <span role="alert">Bilden kunde inte hämtas med aktuell företagsåtkomst.</span>;
  if (protectedImage && !blob) return <span>Laddar bild…</span>;
  return <img {...props} src={protectedImage ? blob : src} />;
}