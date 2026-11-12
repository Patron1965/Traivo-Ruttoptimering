import JSZip from "jszip";

export type WorkbookValue = string | number | boolean | Date | null | undefined;
export type WorkbookRow = Record<string, WorkbookValue>;

export interface WorkbookSheet {
  name: string;
  rows: WorkbookRow[];
  preferredColumns: string[];
}

export interface PlanningSelection {
  planId?: string;
  from?: Date;
  to?: Date;
}

export function matchesPlanningSelection(
  stop: { planningPlanId: string | null; planningDate: Date | null },
  selection: PlanningSelection,
): boolean {
  if (selection.planId) return stop.planningPlanId === selection.planId;
  if (!selection.from || !stop.planningDate) return false;
  if (stop.planningDate < selection.from) return false;
  if (selection.to && stop.planningDate > selection.to) return false;
  return true;
}

const CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function escapeXml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(index: number): string {
  let result = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  }
  return result;
}

function sheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 31) || "Blad";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase("sv-SE"))) {
    const ending = ` ${suffix++}`;
    candidate = `${base.slice(0, 31 - ending.length)}${ending}`;
  }
  used.add(candidate.toLocaleLowerCase("sv-SE"));
  return candidate;
}

function orderedColumns(sheet: WorkbookSheet): string[] {
  const found = new Set<string>();
  for (const row of sheet.rows) {
    for (const key of Object.keys(row)) found.add(key);
  }
  const preferred = sheet.preferredColumns.filter((column) => found.has(column));
  const extra = [...found].filter((column) => !sheet.preferredColumns.includes(column));
  return [...preferred, ...extra];
}

function cellXml(value: WorkbookValue, reference: string, style = 0): string {
  if (value == null || value === "") return `<c r="${reference}" s="${style}"/>`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  }
  const text = value instanceof Date ? value.toISOString() : typeof value === "boolean" ? (value ? "Ja" : "Nej") : value;
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function worksheetXml(sheet: WorkbookSheet): string {
  const columns = orderedColumns(sheet);
  const header = columns.map((column, index) => cellXml(column, `${columnName(index)}1`, 1)).join("");
  const dataRows = sheet.rows.map((row, rowIndex) => {
    const cells = columns.map((column, columnIndex) =>
      cellXml(row[column], `${columnName(columnIndex)}${rowIndex + 2}`)).join("");
    return `<row r="${rowIndex + 2}">${cells}</row>`;
  }).join("");
  const widths = columns.map((column, index) => {
    const longest = Math.max(
      column.length,
      ...sheet.rows.map((row) => String(row[column] ?? "").length),
    );
    return `<col min="${index + 1}" max="${index + 1}" width="${Math.min(45, Math.max(12, longest + 2))}" customWidth="1"/>`;
  }).join("");
  const lastCell = `${columnName(Math.max(0, columns.length - 1))}${sheet.rows.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${widths}</cols>
  <sheetData><row r="1">${header}</row>${dataRows}</sheetData>
  <autoFilter ref="A1:${lastCell}"/>
</worksheet>`;
}

export async function buildRoutePlanWorkbook(sheets: WorkbookSheet[]): Promise<Buffer> {
  const zip = new JSZip();
  const usedNames = new Set<string>();
  const names = sheets.map((sheet) => sheetName(sheet.name, usedNames));

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>
</workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}
  <Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0891B2"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`);
  sheets.forEach((sheet, index) => zip.file(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet)));

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: CONTENT_TYPE,
  });
}

export const ROUTE_PLAN_XLSX_CONTENT_TYPE = CONTENT_TYPE;