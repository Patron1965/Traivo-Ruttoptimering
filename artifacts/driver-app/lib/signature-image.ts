import { encodeMonochromePng } from "./monochrome-png.ts";

export interface SignaturePoint {
  x: number;
  y: number;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode the actual drawing surface as PNG, without DOM/native dependencies.
 * SVG is intentionally not accepted by the server's image-upload scanner.
 */
export function signaturePngDataUrl(
  paths: readonly (readonly SignaturePoint[])[],
  surfaceWidth = 300,
  surfaceHeight = 200,
): string {
  const width = Math.round(surfaceWidth);
  const height = Math.round(surfaceHeight);
  if (!Number.isFinite(surfaceWidth) || !Number.isFinite(surfaceHeight)
    || width < 1 || height < 1 || width > 1024 || height > 1024) {
    throw new Error("SIGNATURE_DIMENSIONS_INVALID");
  }
  if (!paths.some((path) => path.length >= 2)
    || paths.reduce((count, path) => count + path.length, 0) > 50_000) {
    throw new Error("SIGNATURE_POINTS_INVALID");
  }
  for (const path of paths) {
    if (path.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      throw new Error("SIGNATURE_POINTS_INVALID");
    }
  }
  const pixels = new Uint8Array(width * height).fill(255);
  const pointAt = (point: SignaturePoint) => ({
    x: Math.max(0, Math.min(width - 1, Math.round(point.x))),
    y: Math.max(0, Math.min(height - 1, Math.round(point.y))),
  });
  const inkAt = (x: number, y: number) => {
    // Match the two-pixel stroke used by the signature pad.
    for (const offsetY of [-1, 0]) {
      for (const offsetX of [0, 1]) {
        const px = x + offsetX;
        const py = y + offsetY;
        if (px >= 0 && px < width && py >= 0 && py < height) {
          pixels[py * width + px] = 0;
        }
      }
    }
  };
  for (const path of paths) {
    for (let index = 1; index < path.length; index++) {
      let { x, y } = pointAt(path[index - 1]);
      const end = pointAt(path[index]);
      const dx = Math.abs(end.x - x);
      const dy = -Math.abs(end.y - y);
      const stepX = x < end.x ? 1 : -1;
      const stepY = y < end.y ? 1 : -1;
      let error = dx + dy;
      while (true) {
        inkAt(x, y);
        if (x === end.x && y === end.y) break;
        const doubledError = 2 * error;
        if (doubledError >= dy) { error += dy; x += stepX; }
        if (doubledError <= dx) { error += dx; y += stepY; }
      }
    }
  }
  const png = encodeMonochromePng(width, height, pixels);
  let base64 = "";
  for (let index = 0; index < png.length; index += 3) {
    const value = (png[index] << 16) | ((png[index + 1] ?? 0) << 8) | (png[index + 2] ?? 0);
    base64 += BASE64[(value >>> 18) & 63] + BASE64[(value >>> 12) & 63]
      + (index + 1 < png.length ? BASE64[(value >>> 6) & 63] : "=")
      + (index + 2 < png.length ? BASE64[value & 63] : "=");
  }
  return `data:image/png;base64,${base64}`;
}
