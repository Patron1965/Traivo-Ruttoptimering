// Pure helpers for the customer Excel import. No React, no network.
// The server is the final authority; these only produce a preview.

export const CUSTOMER_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const CUSTOMER_IMPORT_MAX_ROWS = 500;

export type CustomerImportField =
  | "name" | "customerNumber" | "address" | "postalCode" | "city" | "country"
  | "contactName" | "phone" | "email" | "instructions";

export const CUSTOMER_IMPORT_FIELDS: { key: CustomerImportField; label: string; required?: boolean; aliases: string[] }[] = [
  { key: "name", label: "Kundnamn", required: true, aliases: ["kundnamn", "namn", "kund", "name", "customer", "customername", "företag", "foretag"] },
  { key: "customerNumber", label: "Kundnummer", aliases: ["kundnummer", "kundnr", "customernumber", "nr", "id"] },
  { key: "address", label: "Adress", aliases: ["adress", "gatuadress", "address", "street", "besöksadress", "besoksadress"] },
  { key: "postalCode", label: "Postnummer", aliases: ["postnummer", "postnr", "postalcode", "zip"] },
  { key: "city", label: "Ort", aliases: ["ort", "postort", "stad", "city"] },
  { key: "country", label: "Land", aliases: ["land", "country"] },
  { key: "contactName", label: "Kontaktperson", aliases: ["kontaktperson", "kontakt", "contact", "contactname"] },
  { key: "phone", label: "Telefon", aliases: ["telefon", "tel", "mobil", "phone"] },
  { key: "email", label: "E-post", aliases: ["epost", "e-post", "email", "mail"] },
  { key: "instructions", label: "Leveransinstruktioner", aliases: ["instruktioner", "leveransinstruktioner", "portkod", "instructions", "anteckning"] },
];

export type CustomerImportMapping = Partial<Record<CustomerImportField, number>>;

const squash = (v: string) => v.toLowerCase().replace(/[\s_\-.]/g, "");

export function guessCustomerMapping(headers: string[]): CustomerImportMapping {
  const mapping: CustomerImportMapping = {};
  const used = new Set<number>();
  for (const field of CUSTOMER_IMPORT_FIELDS) {
    const aliases = field.aliases.map(squash);
    const idx = headers.findIndex((h, i) => !used.has(i) && aliases.includes(squash(h)));
    if (idx >= 0) { mapping[field.key] = idx; used.add(idx); }
  }
  return mapping;
}

export interface SheetRow { rowNumber: number; cells: string[] }

/** Splits a sheet (array of arrays) into header + nonempty data rows with 1-based Excel row numbers. */
export function sheetToRows(matrix: unknown[][]): { headers: string[]; rows: SheetRow[] } {
  const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
  let headerIdx = matrix.findIndex((r) => (r ?? []).some((c) => str(c) !== ""));
  if (headerIdx < 0) return { headers: [], rows: [] };
  const headers = (matrix[headerIdx] ?? []).map(str);
  const rows: SheetRow[] = [];
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const cells = (matrix[i] ?? []).map(str);
    if (cells.some((c) => c !== "")) rows.push({ rowNumber: i + 1, cells });
  }
  return { headers, rows };
}

export interface MappedCustomerRow {
  name: string; customerNumber: string; address: string; postalCode: string; city: string;
  country: string; contactName: string; phone: string; email: string; instructions: string;
}

export function mapRow(cells: string[], mapping: CustomerImportMapping): MappedCustomerRow {
  const get = (k: CustomerImportField) => {
    const i = mapping[k];
    return i === undefined ? "" : (cells[i] ?? "").trim().replace(/\s+/g, " ");
  };
  return {
    name: get("name"), customerNumber: get("customerNumber"), address: get("address"),
    postalCode: get("postalCode"), city: get("city"), country: get("country"),
    contactName: get("contactName"), phone: get("phone"), email: get("email"), instructions: get("instructions"),
  };
}

export const normalizeKey = (v: string | null | undefined) =>
  (v ?? "").toLowerCase().trim();

export interface ExistingCustomerLike {
  name: string; customerNumber?: string | null; address?: string | null; archivedAt?: string | null;
  sites?: { address: string }[];
}

export function dedupKey(row: { name: string; customerNumber?: string | null; address?: string | null }): string {
  const nr = normalizeKey(row.customerNumber);
  if (nr) return `nr:${nr}`;
  return `na:${normalizeKey(row.name)}|${normalizeKey(row.address)}`;
}

export type RowStatus = "ready" | "readyNoSite" | "invalid" | "existing" | "existingArchived" | "duplicateInFile";

export interface PreviewRow {
  rowNumber: number;
  data: MappedCustomerRow;
  status: RowStatus;
  issues: string[];
  duplicateOfRow?: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRow(d: MappedCustomerRow): string[] {
  const issues: string[] = [];
  if (!d.name) issues.push("Kundnamn saknas");
  else if (d.name.length > 200) issues.push("Kundnamn är längre än 200 tecken");
  if (d.email && !EMAIL_RE.test(d.email)) issues.push("Ogiltig e-postadress");
  if (d.phone.length > 100) issues.push("Telefon är för lång");
  if (d.customerNumber.length > 100) issues.push("Kundnummer är för långt");
  if (d.postalCode.length > 30) issues.push("Postnummer är för långt");
  if (d.address.length > 500) issues.push("Adress är för lång");
  if (!d.address && (d.postalCode || d.city)) issues.push("Postnummer/ort angivet men gatuadress saknas");
  return issues;
}

export function buildPreview(rows: SheetRow[], mapping: CustomerImportMapping, existing: ExistingCustomerLike[]): PreviewRow[] {
  const existingIndex = new Map<string, boolean>();
  for (const c of existing) {
    const archived = !!c.archivedAt;
    const keys = [dedupKey(c), dedupKey({ name: c.name, address: c.address })];
    for (const k of keys) if (!existingIndex.has(k) || existingIndex.get(k)) existingIndex.set(k, archived);
  }
  const seen = new Map<string, number>();
  return rows.map(({ rowNumber, cells }) => {
    const data = mapRow(cells, mapping);
    const issues = validateRow(data);
    if (issues.length) return { rowNumber, data, status: "invalid", issues };
    const key = dedupKey({ name: data.name, customerNumber: data.customerNumber, address: fullAddress(data) || data.address });
    const hit = existingIndex.get(key);
    if (hit !== undefined) return { rowNumber, data, status: hit ? "existingArchived" : "existing", issues: [] };
    const prior = seen.get(key);
    if (prior !== undefined) return { rowNumber, data, status: "duplicateInFile", issues: [], duplicateOfRow: prior };
    seen.set(key, rowNumber);
    return { rowNumber, data, status: data.address ? "ready" : "readyNoSite", issues: [] };
  });
}

export function fullAddress(d: MappedCustomerRow): string {
  const locality = [d.postalCode, d.city].filter(Boolean).join(" ");
  return [d.address, locality, d.country].filter(Boolean).join(", ");
}

export const isImportable = (s: RowStatus) => s === "ready" || s === "readyNoSite";

/** Build the CustomerInput body. Site is only included with a street address; the server geocodes. */
export function toCustomerInput(d: MappedCustomerRow) {
  const n = (v: string) => (v ? v : null);
  const address = fullAddress(d);
  return {
    name: d.name,
    customerNumber: n(d.customerNumber),
    address: n(address),
    postalCode: n(d.postalCode),
    city: n(d.city),
    country: n(d.country),
    contactName: n(d.contactName),
    phone: n(d.phone),
    email: n(d.email),
    notes: n(d.instructions),
    sites: d.address
      ? [{
          name: d.name,
          address,
          contactName: n(d.contactName),
          contactPhone: n(d.phone),
          contactEmail: n(d.email),
          instructions: n(d.instructions),
        }]
      : [],
  };
}

export const STATUS_LABEL: Record<RowStatus, string> = {
  ready: "Importeras",
  readyNoSite: "Importeras utan plats",
  invalid: "Ogiltig",
  existing: "Finns redan – hoppas över",
  existingArchived: "Finns arkiverad – hoppas över",
  duplicateInFile: "Dubblett i filen",
};
