export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Detect the true image type from the file's magic bytes (file signature),
 * independent of any client-supplied MIME type. Returns null for anything that
 * is not one of the allowed raster image formats (this also rejects SVG, HTML,
 * PDF, archives and executables, which never carry these signatures).
 */
export function detectImageType(buf: Buffer): (typeof ALLOWED_IMAGE_TYPES)[number] | null {
  if (buf.length < 12) return null;

  // JPEG: SOI marker FF D8 FF, and the file must end with the EOI marker FF D9.
  if (
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff &&
    buf[buf.length - 2] === 0xff &&
    buf[buf.length - 1] === 0xd9
  ) {
    return "image/jpeg";
  }

  // PNG: full 8-byte signature 89 50 4E 47 0D 0A 1A 0A.
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (PNG_SIG.every((b, i) => buf[i] === b)) return "image/png";

  // WebP: RIFF....WEBP container.
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }

  // GIF: GIF87a or GIF89a header.
  const gifHeader = buf.toString("ascii", 0, 6);
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return "image/gif";

  return null;
}

const EICAR_SIGNATURE = "x5o!p%@ap[4\\pzx54(p^)7cc)7}$eicar";

// Polyglot payloads that can hide inside an otherwise-valid image (e.g. PHP in a
// JPEG comment) plus the EICAR antivirus test string. Tokens are >=5 chars to
// keep false positives on real binary image data negligible.
const MALICIOUS_PATTERNS: { needle: string; label: string }[] = [
  { needle: EICAR_SIGNATURE, label: "EICAR test signature" },
  { needle: "<?php", label: "embedded PHP code" },
  { needle: "<script", label: "embedded script" },
  { needle: "<iframe", label: "embedded iframe" },
  { needle: "javascript:", label: "embedded javascript URI" },
];

/**
 * Scan the raw bytes for known-malicious content embedded in a file that may
 * otherwise pass the magic-byte check (polyglots, appended payloads, EICAR).
 * Returns a human-readable reason when something suspicious is found, else null.
 */
export function scanForMaliciousContent(buf: Buffer): string | null {
  const text = buf.toString("latin1").toLowerCase();
  for (const p of MALICIOUS_PATTERNS) {
    if (text.includes(p.needle)) return p.label;
  }
  return null;
}

export type ScanResult =
  | { ok: true; contentType: (typeof ALLOWED_IMAGE_TYPES)[number] }
  | { ok: false; status: number; error: string };

/**
 * Strict server-side validation + content scan for an uploaded image buffer:
 *  1. non-empty and within the size cap
 *  2. real type detected from magic bytes is an allowed image format
 *  3. detected type matches the client-declared type (if provided)
 *  4. no malicious payload found by the content scan
 * Returns the trusted content type to store with, or a status + clear message.
 */
export function validateAndScanImage(opts: {
  buffer: Buffer;
  declaredType?: string | null;
  maxBytes?: number;
}): ScanResult {
  const { buffer, declaredType } = opts;
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;

  if (!buffer || buffer.length === 0) {
    return { ok: false, status: 400, error: "Empty file — nothing to upload" };
  }
  if (buffer.length > maxBytes) {
    return { ok: false, status: 413, error: `File too large (max ${Math.floor(maxBytes / (1024 * 1024))} MB)` };
  }

  const detected = detectImageType(buffer);
  if (!detected) {
    return {
      ok: false,
      status: 400,
      error: "Unsupported file type — only JPEG, PNG, WebP or GIF images are allowed",
    };
  }

  if (declaredType && declaredType.startsWith("image/")) {
    const normalized = declaredType === "image/jpg" ? "image/jpeg" : declaredType;
    if (normalized !== detected) {
      return {
        ok: false,
        status: 400,
        error: `File contents (${detected}) do not match the declared type (${declaredType})`,
      };
    }
  }

  const malicious = scanForMaliciousContent(buffer);
  if (malicious) {
    return { ok: false, status: 400, error: `File rejected by security scan: ${malicious} detected` };
  }

  return { ok: true, contentType: detected };
}
