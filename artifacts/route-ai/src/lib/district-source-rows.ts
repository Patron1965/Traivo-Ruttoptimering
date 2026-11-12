import type { ParsedImportFile } from "./import-file.ts";

export interface SourceRowPayload {
  sourceRowNumber: number;
  original: Record<string, string>;
  parseError?: string;
}

/**
 * Every parsed data row in physical file order, keyed by its original 1-based
 * line number. Malformed/empty rows keep raw cells plus parseError so the
 * server counts them as rejected; they are never padded into valid records.
 */
export function buildSourceRows(parsed: ParsedImportFile): SourceRowPayload[] {
  const cells = (values: string[]) => {
    const original: Record<string, string> = {};
    values.forEach((v, i) => { original[parsed.headers[i] ?? `Kolumn ${i + 1}`] = v; });
    return original;
  };
  return [
    ...parsed.rows.map((r) => ({ sourceRowNumber: r.sourceRowNumber, original: cells(r.values) })),
    ...parsed.rejectedRows.map((r) => ({ sourceRowNumber: r.sourceRowNumber, original: cells(r.values), parseError: r.reasons.join(" ") })),
  ].sort((a, b) => a.sourceRowNumber - b.sourceRowNumber);
}

async function sha256Hex(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bounded (<=200 chars) idempotency key: SHA-256 of file bytes plus SHA-256 of the mapping JSON. */
export async function buildSourceKey(file: ArrayBuffer, mapping: { objectNumber: string; address: string; latitude: string; longitude: string }): Promise<string> {
  const fileHash = await sha256Hex(file);
  const mappingJson = JSON.stringify([mapping.objectNumber, mapping.address, mapping.latitude, mapping.longitude]);
  const mappingHash = await sha256Hex(new TextEncoder().encode(mappingJson));
  return `district:v1:${fileHash}:${mappingHash}`;
}
