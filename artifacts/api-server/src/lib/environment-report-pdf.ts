import type { SustainabilityStats } from "../services/sustainability";

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 44;
const COLORS = {
  ink: [24, 36, 52] as const,
  muted: [101, 116, 139] as const,
  light: [241, 245, 249] as const,
  line: [226, 232, 240] as const,
  green: [16, 185, 129] as const,
  greenDark: [5, 124, 91] as const,
  blue: [37, 99, 235] as const,
  amber: [245, 158, 11] as const,
  white: [255, 255, 255] as const,
};

type Color = readonly [number, number, number];

function pdfNumber(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "0";
}

function winAnsiByte(character: string): number {
  const codePoint = character.codePointAt(0) ?? 63;
  const special: Record<number, number> = {
    0x20ac: 0x80,
    0x2013: 0x96,
    0x2014: 0x97,
    0x2018: 0x91,
    0x2019: 0x92,
    0x201c: 0x93,
    0x201d: 0x94,
    0x2022: 0x95,
    0x00a0: 0xa0,
  };
  return special[codePoint] ?? (codePoint <= 0xff ? codePoint : 0x3f);
}

function textHex(value: string): string {
  return Array.from(value)
    .map((character) => winAnsiByte(character).toString(16).padStart(2, "0"))
    .join("");
}

function rgb(color: Color, mode: "fill" | "stroke"): string {
  return `${color.map((channel) => pdfNumber(channel / 255)).join(" ")} ${mode === "fill" ? "rg" : "RG"}`;
}

function wrapText(value: string, maxCharacters: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if ((current.length + word.length + 1) <= maxCharacters) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

class PdfDocument {
  private readonly pages: string[] = [];
  private current = "";

  private flushPage() {
    if (this.current) this.pages.push(this.current);
    this.current = "";
  }

  newPage() {
    this.flushPage();
  }

  rect(x: number, top: number, width: number, height: number, color: Color, filled = true) {
    const y = PAGE_HEIGHT - top - height;
    this.current += `${rgb(color, filled ? "fill" : "stroke")} ${pdfNumber(x)} ${pdfNumber(y)} ${pdfNumber(width)} ${pdfNumber(height)} re ${filled ? "f" : "S"}\n`;
  }

  line(x1: number, top1: number, x2: number, top2: number, color: Color, width = 1) {
    this.current += `${rgb(color, "stroke")} ${pdfNumber(width)} w ${pdfNumber(x1)} ${pdfNumber(PAGE_HEIGHT - top1)} m ${pdfNumber(x2)} ${pdfNumber(PAGE_HEIGHT - top2)} l S\n`;
  }

  text(value: string, x: number, top: number, size: number, color: Color, bold = false) {
    const y = PAGE_HEIGHT - top - size;
    this.current += `${rgb(color, "fill")} BT /${bold ? "F2" : "F1"} ${pdfNumber(size)} Tf ${pdfNumber(x)} ${pdfNumber(y)} Td <${textHex(value)}> Tj ET\n`;
  }

  wrappedText(value: string, x: number, top: number, width: number, size: number, color: Color, lineHeight = 1.35) {
    const maxCharacters = Math.max(12, Math.floor(width / (size * 0.52)));
    const lines = wrapText(value, maxCharacters);
    lines.forEach((line, index) => this.text(line, x, top + index * size * lineHeight, size, color));
    return lines.length * size * lineHeight;
  }

  finish(): Buffer {
    this.flushPage();
    const objects: Buffer[] = [];
    const addObject = (value: string | Buffer) => {
      objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value, "latin1"));
      return objects.length;
    };

    const pageObjectIds: number[] = [];
    const contentObjectIds: number[] = [];
    for (const page of this.pages) {
      const stream = Buffer.from(page, "latin1");
      const contentId = addObject(Buffer.concat([
        Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "latin1"),
        stream,
        Buffer.from("\nendstream", "latin1"),
      ]));
      contentObjectIds.push(contentId);
      pageObjectIds.push(0);
    }

    const catalogId = addObject("");
    const pagesId = addObject("");
    const regularFontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const boldFontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

    for (let index = 0; index < this.pages.length; index++) {
      pageObjectIds[index] = addObject(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >> >> /Contents ${contentObjectIds[index]} 0 R >>`,
      );
    }

    objects[catalogId - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, "latin1");
    objects[pagesId - 1] = Buffer.from(
      `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>`,
      "latin1",
    );

    const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
    const offsets: number[] = [0];
    let offset = chunks[0].length;
    objects.forEach((object, index) => {
      offsets.push(offset);
      const header = Buffer.from(`${index + 1} 0 obj\n`, "latin1");
      const footer = Buffer.from("\nendobj\n", "latin1");
      chunks.push(header, object, footer);
      offset += header.length + object.length + footer.length;
    });

    const xrefOffset = offset;
    chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, "latin1"));
    for (let index = 1; index <= objects.length; index++) {
      chunks.push(Buffer.from(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`, "latin1"));
    }
    chunks.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`, "latin1"));
    return Buffer.concat(chunks);
  }
}

function formatNumber(value: number, decimals = 1): string {
  return new Intl.NumberFormat("sv-SE", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDate(date: Date | undefined): string {
  return date ? new Intl.DateTimeFormat("sv-SE", { dateStyle: "medium", timeZone: "UTC" }).format(date) : "";
}

function formatPeriod(from: Date | undefined, to: Date | undefined): string {
  if (from && to) return `${formatDate(from)} – ${formatDate(to)}`;
  if (from) return `Från ${formatDate(from)}`;
  if (to) return `Till ${formatDate(to)}`;
  return "Alla tillgängliga rutter";
}

function vehicleLabel(type: string): string {
  if (type === "electric") return "El";
  if (type === "hybrid") return "Hybrid";
  if (type === "diesel_truck") return "Diesel lastbil";
  return "Fossil";
}

function drawKpi(doc: PdfDocument, x: number, top: number, width: number, label: string, value: string, accent: Color) {
  doc.rect(x, top, width, 82, COLORS.white);
  doc.rect(x, top, 4, 82, accent);
  doc.text(label, x + 16, top + 15, 9, COLORS.muted);
  doc.text(value, x + 16, top + 34, 20, COLORS.ink, true);
}

function drawScoreCard(doc: PdfDocument, x: number, top: number, width: number, label: string, score: number, color: Color) {
  doc.rect(x, top, width, 94, COLORS.light);
  doc.text(label, x + 14, top + 14, 9, COLORS.muted);
  doc.text(`${Math.round(score)}/100`, x + 14, top + 36, 23, color, true);
  doc.rect(x + 14, top + 72, width - 28, 6, COLORS.white);
  doc.rect(x + 14, top + 72, Math.max(2, (width - 28) * Math.max(0, Math.min(100, score)) / 100), 6, color);
}

export function buildEnvironmentReportPdf(
  stats: SustainabilityStats,
  from?: Date,
  to?: Date,
): Buffer {
  const doc = new PdfDocument();
  const totalDistance = stats.routeBreakdown.reduce((sum, route) => sum + Number(route.distanceKm ?? 0), 0);
  const routeCount = stats.routeBreakdown.length;
  const fossilShare = stats.totalCo2Kg > 0 ? stats.fossilCo2Kg / stats.totalCo2Kg : 0;
  const evShare = stats.totalCo2Kg > 0 ? stats.evCo2Kg / stats.totalCo2Kg : 0;
  const hybridShare = stats.totalCo2Kg > 0 ? stats.hybridCo2Kg / stats.totalCo2Kg : 0;
  const period = formatPeriod(from, to);

  doc.rect(0, 0, PAGE_WIDTH, 132, COLORS.ink);
  doc.rect(0, 128, PAGE_WIDTH, 4, COLORS.green);
  doc.text("TRAIVO ROUTE", MARGIN, 27, 11, [167, 243, 208], true);
  doc.text("MILJÖRAPPORT", MARGIN, 52, 28, COLORS.white, true);
  doc.text(`Transportens miljöpåverkan · ${period}`, MARGIN, 91, 11, [203, 213, 225]);
  doc.text("GENERERAD", PAGE_WIDTH - 136, 28, 8, [148, 163, 184], true);
  doc.text(formatDate(new Date()), PAGE_WIDTH - 136, 43, 10, COLORS.white);

  doc.text("Översikt", MARGIN, 160, 16, COLORS.ink, true);
  doc.text("En sammanställning av utsläpp, fordonsmix och miljöpåverkan för vald period.", MARGIN, 183, 10, COLORS.muted);

  const cardGap = 10;
  const cardWidth = (PAGE_WIDTH - 2 * MARGIN - 3 * cardGap) / 4;
  drawKpi(doc, MARGIN, 204, cardWidth, "TOTALT CO2", `${formatNumber(stats.totalCo2Kg)} kg`, COLORS.green);
  drawKpi(doc, MARGIN + cardWidth + cardGap, 204, cardWidth, "KÖRSTRÄCKA", `${formatNumber(totalDistance)} km`, COLORS.blue);
  drawKpi(doc, MARGIN + (cardWidth + cardGap) * 2, 204, cardWidth, "RUTTER", formatNumber(routeCount, 0), COLORS.amber);
  drawKpi(doc, MARGIN + (cardWidth + cardGap) * 3, 204, cardWidth, "MILJÖPOÄNG", `${Math.round(stats.environmentalScore)}/100`, COLORS.greenDark);

  doc.text("Utsläppsprofil", MARGIN, 324, 16, COLORS.ink, true);
  doc.text("Fördelning mellan fordonslag baserat på körsträcka och rapporterade utsläpp.", MARGIN, 347, 10, COLORS.muted);
  const barX = MARGIN;
  const barTop = 374;
  const barWidth = PAGE_WIDTH - 2 * MARGIN;
  const segments = [
    { label: "Fossil", value: stats.fossilCo2Kg, share: fossilShare, color: COLORS.amber },
    { label: "El", value: stats.evCo2Kg, share: evShare, color: COLORS.green },
    { label: "Hybrid", value: stats.hybridCo2Kg, share: hybridShare, color: [139, 92, 246] as const },
  ];
  let segmentX = barX;
  doc.rect(barX, barTop, barWidth, 20, COLORS.light);
  for (const segment of segments) {
    const segmentWidth = barWidth * segment.share;
    if (segmentWidth > 0) {
      doc.rect(segmentX, barTop, segmentWidth, 20, segment.color);
      segmentX += segmentWidth;
    }
  }
  segments.forEach((segment, index) => {
    const x = MARGIN + index * 164;
    doc.rect(x, 420, 8, 8, segment.color);
    doc.text(`${segment.label} · ${formatNumber(segment.value)} kg`, x + 14, 417, 9, COLORS.ink);
    doc.text(`${formatNumber(segment.share * 100, 0)} %`, x + 14, 434, 9, COLORS.muted);
  });

  doc.text("Miljöpåverkan", MARGIN, 484, 16, COLORS.ink, true);
  doc.text("Samlad poäng där lägre utsläpp, mindre buller och färre partiklar ger högre resultat.", MARGIN, 507, 10, COLORS.muted);
  const scoreGap = 10;
  const scoreWidth = (PAGE_WIDTH - 2 * MARGIN - 2 * scoreGap) / 3;
  drawScoreCard(doc, MARGIN, 530, scoreWidth, "TOTAL MILJÖPOÄNG", stats.environmentalScore, COLORS.greenDark);
  drawScoreCard(doc, MARGIN + scoreWidth + scoreGap, 530, scoreWidth, "BULLERBELASTNING", Math.max(0, 100 - stats.noiseImpactScore), COLORS.blue);
  drawScoreCard(doc, MARGIN + (scoreWidth + scoreGap) * 2, 530, scoreWidth, "PARTIKELPOÄNG", Math.max(0, 100 - stats.avgParticlePm25 * 10), COLORS.amber);

  doc.rect(MARGIN, 652, PAGE_WIDTH - 2 * MARGIN, 74, [236, 253, 245]);
  doc.text("MÖJLIG KLIMATNYTTA", MARGIN + 18, 668, 8, COLORS.greenDark, true);
  doc.text(`${formatNumber(stats.co2SavedKg)} kg CO2`, MARGIN + 18, 684, 18, COLORS.ink, true);
  doc.text(`beräknad besparing jämfört med fossil referens · cirka ${formatNumber(stats.treesEquivalent, 0)} träd-ekvivalenter`, MARGIN + 190, 689, 9, COLORS.muted);
  drawFooter(doc, 1);

  doc.newPage();
  doc.rect(0, 0, PAGE_WIDTH, 92, COLORS.ink);
  doc.rect(0, 88, PAGE_WIDTH, 4, COLORS.green);
  doc.text("MILJÖRAPPORT", MARGIN, 25, 22, COLORS.white, true);
  doc.text("Ruttöversikt och beräkningsunderlag", MARGIN, 59, 11, [203, 213, 225]);
  doc.text(period, PAGE_WIDTH - 176, 36, 9, [203, 213, 225]);

  doc.text("Rutter i perioden", MARGIN, 126, 16, COLORS.ink, true);
  doc.text("De mest relevanta rutterna visas nedan. Samtliga rutter ingår i nyckeltalen på föregående sida.", MARGIN, 149, 10, COLORS.muted);

  const columns = [
    { label: "RUTT", x: MARGIN, width: 175 },
    { label: "FORDON", x: MARGIN + 175, width: 92 },
    { label: "DATUM", x: MARGIN + 267, width: 80 },
    { label: "KM", x: MARGIN + 347, width: 55 },
    { label: "CO2", x: MARGIN + 402, width: 55 },
    { label: "TYP", x: MARGIN + 457, width: 50 },
  ];
  doc.rect(MARGIN, 176, PAGE_WIDTH - 2 * MARGIN, 28, COLORS.ink);
  columns.forEach((column) => doc.text(column.label, column.x + 8, 185, 8, COLORS.white, true));
  const rows = stats.routeBreakdown.slice(0, 17);
  rows.forEach((route, index) => {
    const top = 204 + index * 25;
    if (index % 2 === 0) doc.rect(MARGIN, top, PAGE_WIDTH - 2 * MARGIN, 25, [248, 250, 252]);
    const routeName = (route.routeName ?? "Namnlös rutt").slice(0, 28);
    const date = route.date ? new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeZone: "UTC" }).format(new Date(route.date)) : "–";
    doc.text(routeName, MARGIN + 8, top + 7, 8.5, COLORS.ink);
    doc.text((route.vehicleName ?? "–").slice(0, 14), MARGIN + 183, top + 7, 8.5, COLORS.ink);
    doc.text(date, MARGIN + 275, top + 7, 8.5, COLORS.muted);
    doc.text(formatNumber(Number(route.distanceKm ?? 0), 0), MARGIN + 355, top + 7, 8.5, COLORS.ink);
    doc.text(formatNumber(Number(route.co2Kg ?? 0), 1), MARGIN + 410, top + 7, 8.5, COLORS.ink);
    doc.text(vehicleLabel(route.vehicleType), MARGIN + 465, top + 7, 8.2, COLORS.muted);
  });

  const noteTop = 204 + Math.max(rows.length, 1) * 25 + 20;
  if (routeCount > rows.length) {
    doc.wrappedText(`Visar ${rows.length} av ${routeCount} rutter. Nyckeltalen omfattar hela det valda underlaget.`, MARGIN, noteTop, PAGE_WIDTH - 2 * MARGIN, 9, COLORS.muted);
  } else if (!rows.length) {
    doc.text("Inga rutter hittades för vald period.", MARGIN, noteTop, 10, COLORS.muted);
  }

  const methodologyTop = Math.min(700, noteTop + 34);
  doc.line(MARGIN, methodologyTop, PAGE_WIDTH - MARGIN, methodologyTop, COLORS.line);
  doc.text("Om beräkningen", MARGIN, methodologyTop + 18, 11, COLORS.ink, true);
  doc.wrappedText(
    "CO2 baseras på Traivo Routes fordonsprofiler och ruttens körsträcka. Miljöpoängen väger samman CO2, buller och uppskattade PM2.5-partiklar. Rapporten är ett operativt beslutsunderlag, inte en extern klimatverifiering.",
    MARGIN,
    methodologyTop + 38,
    PAGE_WIDTH - 2 * MARGIN,
    9,
    COLORS.muted,
  );
  drawFooter(doc, 2);

  return doc.finish();
}

function drawFooter(doc: PdfDocument, page: number) {
  doc.line(MARGIN, 790, PAGE_WIDTH - MARGIN, 790, COLORS.line);
  doc.text("Traivo Route · Miljörapport", MARGIN, 803, 8, COLORS.muted);
  doc.text(`Sida ${page}`, PAGE_WIDTH - 84, 803, 8, COLORS.muted);
}