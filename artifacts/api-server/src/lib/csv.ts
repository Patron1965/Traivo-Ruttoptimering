function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  // Neutralize CSV/formula injection: a cell beginning with =, +, -, @, tab or
  // CR is interpreted as a formula by spreadsheet apps (Excel/Sheets/LibreOffice).
  // Prefix with a single quote so the value is always treated as literal text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Serialize an array of row objects to CSV (RFC-4180 style, CRLF line endings).
 * The header is the union of all keys across rows so sparse rows stay aligned.
 * Objects/arrays are JSON-encoded, Dates become ISO-8601, null/undefined empty.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headerSet = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) headerSet.add(k);
  const headers = Array.from(headerSet);
  const lines = [headers.map(cell).join(",")];
  for (const r of rows) lines.push(headers.map((h) => cell(r[h])).join(","));
  return lines.join("\r\n");
}
