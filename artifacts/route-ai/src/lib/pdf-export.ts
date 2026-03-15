import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

interface AnalyticsPdfData {
  title: string;
  dateRange: string;
  summary: {
    totalRoutes: number;
    totalStops: number;
    completedStops: number;
    failedStops: number;
    onTimeRate: number;
    totalDistanceKm: number;
    totalCo2Kg: number;
    avgStopsPerRoute: number;
  };
  vehicleBreakdown: Array<{ type: string; routes: number; distanceKm: number; co2Kg: number }>;
  statusBreakdown: Record<string, number>;
}

interface DriverPdfData {
  title: string;
  driverName: string;
  phone: string | null;
  totalDeliveries: number;
  completedDeliveries: number;
  failedDeliveries: number;
  skippedDeliveries: number;
  onTimeRate: number;
  avgServiceDurationMin: number;
  totalDistanceKm: number;
  totalRoutes: number;
  completedRoutes: number;
}

function addHeader(doc: jsPDF, title: string, subtitle: string) {
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, doc.internal.pageSize.getWidth(), 40, "F");
  doc.setTextColor(0, 191, 179);
  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.text("RouteAI", 14, 18);
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.text(title, 14, 32);
  doc.setTextColor(150, 150, 150);
  doc.setFontSize(9);
  doc.text(subtitle, doc.internal.pageSize.getWidth() - 14, 32, { align: "right" });
}

function addKpiRow(doc: jsPDF, y: number, items: Array<{ label: string; value: string }>) {
  const width = (doc.internal.pageSize.getWidth() - 28) / items.length;
  items.forEach((item, i) => {
    const x = 14 + i * width;
    doc.setFillColor(241, 245, 249);
    doc.roundedRect(x, y, width - 4, 28, 3, 3, "F");
    doc.setTextColor(100, 116, 139);
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    doc.text(item.label, x + 6, y + 10);
    doc.setTextColor(15, 23, 42);
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text(item.value, x + 6, y + 23);
  });
  return y + 34;
}

export function exportAnalyticsPdf(data: AnalyticsPdfData) {
  const doc = new jsPDF();
  const now = new Date().toLocaleString();

  addHeader(doc, data.title, `${data.dateRange} | ${now}`);

  let y = 50;
  y = addKpiRow(doc, y, [
    { label: "Totala rutter", value: `${data.summary.totalRoutes}` },
    { label: "Totala stopp", value: `${data.summary.totalStops}` },
    { label: "I tid-andel", value: `${data.summary.onTimeRate}%` },
    { label: "Total sträcka", value: `${data.summary.totalDistanceKm} km` },
  ]);

  y = addKpiRow(doc, y, [
    { label: "Slutförda stopp", value: `${data.summary.completedStops}` },
    { label: "Misslyckade", value: `${data.summary.failedStops}` },
    { label: "Total CO₂", value: `${data.summary.totalCo2Kg} kg` },
    { label: "Snitt stopp/rutt", value: `${data.summary.avgStopsPerRoute}` },
  ]);

  y += 6;
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.text("Ruttstatus", 14, y);
  y += 4;

  const statusEntries = Object.entries(data.statusBreakdown);
  if (statusEntries.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [["Status", "Antal"]],
      body: statusEntries.map(([status, count]) => [status, `${count}`]),
      theme: "grid",
      headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontSize: 9 },
      bodyStyles: { fontSize: 9 },
      margin: { left: 14, right: 14 },
    });
    y = (doc as any).lastAutoTable.finalY + 10;
  }

  if (data.vehicleBreakdown.length > 0) {
    doc.setTextColor(15, 23, 42);
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text("Fordonstyper", 14, y);
    y += 4;

    autoTable(doc, {
      startY: y,
      head: [["Typ", "Rutter", "Sträcka (km)", "CO₂ (kg)"]],
      body: data.vehicleBreakdown.map((v) => [v.type, `${v.routes}`, `${v.distanceKm}`, `${v.co2Kg}`]),
      theme: "grid",
      headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontSize: 9 },
      bodyStyles: { fontSize: 9 },
      margin: { left: 14, right: 14 },
    });
  }

  doc.save(`routeai-analytics-${new Date().toISOString().slice(0, 10)}.pdf`);
}

export function exportDriverPdf(data: DriverPdfData) {
  const doc = new jsPDF();
  const now = new Date().toLocaleString();

  addHeader(doc, data.title, now);

  let y = 50;
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(data.driverName, 14, y);
  if (data.phone) {
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 116, 139);
    doc.text(data.phone, 14, y + 7);
    y += 7;
  }
  y += 14;

  y = addKpiRow(doc, y, [
    { label: "Totala leveranser", value: `${data.totalDeliveries}` },
    { label: "Levererade", value: `${data.completedDeliveries}` },
    { label: "Misslyckade", value: `${data.failedDeliveries}` },
    { label: "Hoppade över", value: `${data.skippedDeliveries}` },
  ]);

  y = addKpiRow(doc, y, [
    { label: "I tid-andel", value: `${data.onTimeRate}%` },
    { label: "Snitt servicetid", value: `${data.avgServiceDurationMin} min` },
    { label: "Total sträcka", value: `${data.totalDistanceKm} km` },
    { label: "Rutter (klar/total)", value: `${data.completedRoutes}/${data.totalRoutes}` },
  ]);

  y += 6;
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.text("Prestandaöversikt", 14, y);
  y += 4;

  autoTable(doc, {
    startY: y,
    head: [["Mått", "Värde"]],
    body: [
      ["Slutförandegrad", `${data.totalDeliveries > 0 ? Math.round((data.completedDeliveries / data.totalDeliveries) * 100) : 0}%`],
      ["I tid-andel", `${data.onTimeRate}%`],
      ["Snitt servicetid", `${data.avgServiceDurationMin} min`],
      ["Total körsträcka", `${data.totalDistanceKm} km`],
      ["Rutter slutförda", `${data.completedRoutes} av ${data.totalRoutes}`],
    ],
    theme: "grid",
    headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    margin: { left: 14, right: 14 },
  });

  doc.save(`routeai-driver-${data.driverName.replace(/\s+/g, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.pdf`);
}
