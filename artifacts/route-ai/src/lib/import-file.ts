import { read as readWorkbook, utils as workbookUtils } from "xlsx";
import { TrustedLocalizedError } from "./localize-error.ts";

export interface ParsedImportRow {
  sourceRowNumber: number;
  values: string[];
}

export interface RejectedImportRow {
  sourceRowNumber: number;
  values: string[];
  reasons: string[];
}

export interface ParsedImportFile {
  headers: string[];
  rows: ParsedImportRow[];
  rejectedRows: RejectedImportRow[];
  sourceRowCount: number;
}

const DELIMITERS = [",", ";", "\t", "|"] as const;

function decodeText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = bytes.subarray(2).slice();
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes).replace(/^\uFEFF/, "");
  }
}

function delimiterCounts(record: string): Map<string, number> {
  const counts = new Map<string, number>(DELIMITERS.map((delimiter) => [delimiter, 0]));
  let quoted = false;
  for (let index = 0; index < record.length; index += 1) {
    const char = record[index];
    if (char === '"') {
      if (quoted && record[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && counts.has(char)) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }
  }
  return counts;
}

export function detectCsvDelimiter(text: string): string {
  const firstRecord = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = delimiterCounts(firstRecord);
  return DELIMITERS.reduce((best, delimiter) =>
    (counts.get(delimiter) ?? 0) > (counts.get(best) ?? 0) ? delimiter : best, ",");
}

function parseCsvRecordsWithLines(
  text: string,
  delimiter = detectCsvDelimiter(text),
  trimFields = true,
): Array<{ values: string[]; sourceRowNumber: number }> {
  const finish = (value: string) => (trimFields ? value.trim() : value);
  const records: Array<{ values: string[]; sourceRowNumber: number }> = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let currentLine = 1;
  let recordStartLine = 1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
        if (char === "\n") currentLine += 1;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      record.push(finish(field));
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      record.push(finish(field));
      records.push({ values: record, sourceRowNumber: recordStartLine });
      record = [];
      field = "";
      currentLine += 1;
      recordStartLine = currentLine;
    } else {
      field += char;
    }
  }
  if (quoted) throw new TrustedLocalizedError("CSV-filen innehåller ett oavslutat citerat fält.");
  if (field.length > 0 || record.length > 0) {
    record.push(finish(field));
    records.push({ values: record, sourceRowNumber: recordStartLine });
  }
  return records;
}

export function parseCsvRecords(text: string, delimiter = detectCsvDelimiter(text)): string[][] {
  return parseCsvRecordsWithLines(text, delimiter).map((record) => record.values);
}

function uniqueHeaders(values: string[]): string[] {
  const seen = new Map<string, number>();
  return values.map((value, index) => {
    const base = value.replace(/^\uFEFF/, "").trim() || `Kolumn ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

function classifyRows(records: string[][], sourceRowNumbers?: number[]): ParsedImportFile {
  if (records.length < 2) {
    throw new TrustedLocalizedError("Filen måste innehålla en rubrikrad och minst en datarad.");
  }
  const headers = uniqueHeaders(records[0]);
  const rows: ParsedImportRow[] = [];
  const rejectedRows: RejectedImportRow[] = [];
  records.slice(1).forEach((values, index) => {
    const sourceRowNumber = sourceRowNumbers?.[index + 1] ?? index + 2;
    if (values.every((value) => String(value).trim() === "")) {
      rejectedRows.push({ sourceRowNumber, values, reasons: ["Raden är tom."] });
    } else if (values.length !== headers.length) {
      rejectedRows.push({
        sourceRowNumber,
        values,
        reasons: [`Raden har ${values.length} kolumner men rubrikraden har ${headers.length}.`],
      });
    } else {
      rows.push({ sourceRowNumber, values: values.map((value) => String(value)) });
    }
  });
  return { headers, rows, rejectedRows, sourceRowCount: records.length - 1 };
}

export interface ParseImportOptions {
  /** Keep exact cell text (no trimming). Used only by district planning. */
  preserveValues?: boolean;
}

export async function parseImportFile(file: File, options: ParseImportOptions = {}): Promise<ParsedImportFile> {
  const extension = file.name.toLocaleLowerCase("sv-SE").split(".").pop();
  if (!extension || !["csv", "xlsx", "xls", "xlsb"].includes(extension)) {
    throw new TrustedLocalizedError("Filformatet stöds inte. Välj CSV, XLSX eller XLS.");
  }
  const buffer = await file.arrayBuffer();
  if (extension === "csv") {
    const records = parseCsvRecordsWithLines(decodeText(buffer), undefined, !options.preserveValues);
    return classifyRows(
      records.map((record) => record.values),
      records.map((record) => record.sourceRowNumber),
    );
  }
  const workbook = readWorkbook(new Uint8Array(buffer), {
    type: "array",
    cellDates: true,
    codepage: 1252,
  });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new TrustedLocalizedError("Arbetsboken saknar kalkylblad.");
  const records = workbookUtils.sheet_to_json<(string | number | Date)[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
    dateNF: "yyyy-mm-dd",
    blankrows: true,
  }).map((row) => row.map((value) => String(value)));
  return classifyRows(records);
}

export function parseLocalizedNumber(value?: string): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  let normalized = value.trim().replace(/[\s\u00A0']/g, "");
  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    normalized = normalized.split(thousands).join("").replace(decimal, ".");
  } else if (comma >= 0) {
    normalized = normalized.replace(/\./g, "").replace(/,/g, ".");
  } else if ((normalized.match(/\./g) ?? []).length > 1) {
    const parts = normalized.split(".");
    normalized = `${parts.slice(0, -1).join("")}.${parts.at(-1)}`;
  }
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeImportDate(value?: string): string | undefined {
  if (value == null || value.trim() === "") return undefined;
  const raw = value.trim();
  let year: number;
  let month: number;
  let day: number;
  let match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) {
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
  } else {
    match = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (!match) return undefined;
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3]);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

export function normalizeImportTime(value?: string): string | undefined {
  if (value == null || value.trim() === "") return undefined;
  const raw = value.trim();
  const compact = raw.match(/^(\d{2})(\d{2})$/);
  const time = compact ?? raw.match(/^(\d{1,2})(?:[:.h](\d{1,2}))?$/i);
  if (time) {
    const hour = Number(time[1]);
    const minute = Number(time[2] ?? 0);
    if (hour <= 23 && minute <= 59) {
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
    return undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
}

export function uniqueCustomFieldKeys(headers: string[], normalize: (header: string) => string): string[] {
  const used = new Set<string>();
  return headers.map((header, index) => {
    const base = `custom_${normalize(header) || `kolumn_${index + 1}`}`;
    let key = base;
    let suffix = 2;
    while (used.has(key)) {
      key = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(key);
    return key;
  });
}