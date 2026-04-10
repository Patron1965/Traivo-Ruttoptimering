import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Upload,
  FileSpreadsheet,
  ArrowRight,
  Check,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Info,
  FileDown,
  Cpu,
  Smartphone,
  Users,
  CheckCircle2,
  XCircle,
  Loader2,
  Truck,
  Zap,
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ORG_ID } from "@/lib/constants";
import { read as xlsxRead, utils as xlsxUtils } from "xlsx";

type SystemField = {
  key: string;
  labelKey: string;
  required: boolean;
  description: string;
  apiField: string;
  exampleValue: string;
};

const SYSTEM_FIELDS: SystemField[] = [
  { key: "referenceNumber", labelKey: "importPage.field.referenceNumber", required: false, description: "importPage.fieldDesc.referenceNumber", apiField: "reference_number", exampleValue: "ORD-2026-001" },
  { key: "date", labelKey: "importPage.field.date", required: true, description: "importPage.fieldDesc.date", apiField: "date", exampleValue: "2026-04-10" },
  { key: "contactName", labelKey: "importPage.field.contactName", required: false, description: "importPage.fieldDesc.contactName", apiField: "contact_name", exampleValue: "Anna Svensson" },
  { key: "contactPhone", labelKey: "importPage.field.contactPhone", required: false, description: "importPage.fieldDesc.contactPhone", apiField: "contact_phone", exampleValue: "+46701234567" },
  { key: "contactEmail", labelKey: "importPage.field.contactEmail", required: false, description: "importPage.fieldDesc.contactEmail", apiField: "contact_email", exampleValue: "anna@example.com" },
  { key: "address", labelKey: "importPage.field.address", required: true, description: "importPage.fieldDesc.address", apiField: "address", exampleValue: "Storgatan 12, Stockholm" },
  { key: "latitude", labelKey: "importPage.field.latitude", required: false, description: "importPage.fieldDesc.latitude", apiField: "latitude", exampleValue: "59.3293" },
  { key: "longitude", labelKey: "importPage.field.longitude", required: false, description: "importPage.fieldDesc.longitude", apiField: "longitude", exampleValue: "18.0686" },
  { key: "timeWindowStart", labelKey: "importPage.field.timeWindowStart", required: false, description: "importPage.fieldDesc.timeWindowStart", apiField: "time_window_start", exampleValue: "08:00" },
  { key: "timeWindowEnd", labelKey: "importPage.field.timeWindowEnd", required: false, description: "importPage.fieldDesc.timeWindowEnd", apiField: "time_window_end", exampleValue: "12:00" },
  { key: "serviceDurationMin", labelKey: "importPage.field.serviceDurationMin", required: false, description: "importPage.fieldDesc.serviceDurationMin", apiField: "service_duration_min", exampleValue: "15" },
  { key: "weightKg", labelKey: "importPage.field.weightKg", required: false, description: "importPage.fieldDesc.weightKg", apiField: "weight_kg", exampleValue: "25.5" },
  { key: "volumeM3", labelKey: "importPage.field.volumeM3", required: false, description: "importPage.fieldDesc.volumeM3", apiField: "volume_m3", exampleValue: "0.5" },
  { key: "notes", labelKey: "importPage.field.notes", required: false, description: "importPage.fieldDesc.notes", apiField: "notes", exampleValue: "Portkod 1234" },
];

const ALIAS_MAP: Record<string, string> = {
  referensnummer: "referenceNumber", reference: "referenceNumber", reference_number: "referenceNumber",
  ref: "referenceNumber", ordernummer: "referenceNumber", order_number: "referenceNumber", ordernr: "referenceNumber",
  datum: "date", date: "date", leveransdatum: "date", delivery_date: "date",
  namn: "contactName", name: "contactName", contact_name: "contactName", kontaktnamn: "contactName",
  mottagare: "contactName", recipient: "contactName", customer_name: "contactName", kundnamn: "contactName",
  telefonnummer: "contactPhone", telefon: "contactPhone", phone: "contactPhone", tel: "contactPhone",
  contact_phone: "contactPhone", mobilnummer: "contactPhone", mobil: "contactPhone", mobile: "contactPhone",
  epost: "contactEmail", "e-post": "contactEmail", email: "contactEmail", mail: "contactEmail", contact_email: "contactEmail",
  address: "address", adress: "address", gatuadress: "address", street: "address",
  street_address: "address", leveransadress: "address", delivery_address: "address",
  latitude: "latitude", lat: "latitude", latitud: "latitude", delivery_latitude: "latitude",
  longitude: "longitude", lng: "longitude", lon: "longitude", long: "longitude", longitud: "longitude", delivery_longitude: "longitude",
  leverans_från_kl: "timeWindowStart", "leverans från kl": "timeWindowStart", time_window_start: "timeWindowStart",
  start_time: "timeWindowStart", starttid: "timeWindowStart", från: "timeWindowStart",
  leverans_till_kl: "timeWindowEnd", "leverans till kl": "timeWindowEnd", time_window_end: "timeWindowEnd",
  end_time: "timeWindowEnd", sluttid: "timeWindowEnd", till: "timeWindowEnd",
  servicetid: "serviceDurationMin", service_duration_min: "serviceDurationMin", duration: "serviceDurationMin", minuter: "serviceDurationMin",
  vikt: "weightKg", weight: "weightKg", weight_kg: "weightKg", kg: "weightKg",
  volym: "volumeM3", volume: "volumeM3", volume_m3: "volumeM3", m3: "volumeM3",
  notering: "notes", notes: "notes", anteckning: "notes", kommentar: "notes", comment: "notes", beskrivning: "notes", description: "notes",
};

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

interface ParsedData {
  headers: string[];
  rows: string[][];
}

interface ColumnMapping {
  [systemField: string]: string | null;
}

interface VehicleData {
  id: string;
  name: string;
  licensePlate: string;
  vehicleType: string;
  isActive: boolean;
  capacityKg: number;
}

interface DriverData {
  id: string;
  name: string;
  phone?: string | null;
  vehicleId?: string | null;
  isActive: boolean;
}

interface OptimizationResult {
  routes: Array<{
    vehicleId: string;
    routeId: string;
    stops: Array<{ stopId: string; sequenceOrder: number; estimatedArrival: string; distanceFromPreviousKm: number }>;
    distanceKm: number;
    durationMin: number;
    co2EmissionsKg: number;
  }>;
  totalDistanceKm: number;
  totalDurationMin: number;
  costBreakdown?: { totalCo2Kg: number };
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = false; }
      } else { current += char; }
    } else {
      if (char === '"') { inQuotes = true; }
      else if (char === delimiter) { result.push(current.trim()); current = ""; }
      else { current += char; }
    }
  }
  result.push(current.trim());
  return result;
}

function downloadTemplate() {
  const headers = SYSTEM_FIELDS.map(f => f.apiField);
  const examples = SYSTEM_FIELDS.map(f => f.exampleValue);
  const csv = [headers.join(";"), examples.join(";")].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "traivo_import_template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

const STEP_ICONS = [Upload, ArrowRight, CheckCircle2, Users, Zap, Send] as const;

export default function Import() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<WizardStep>(1);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounter = useRef(0);

  const [parsedData, setParsedData] = useState<ParsedData | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [mappedRows, setMappedRows] = useState<Record<string, string>[]>([]);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [localDrag, setLocalDrag] = useState(false);
  const localDragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedVehicleIds, setSelectedVehicleIds] = useState<string[]>([]);
  const [importedStopIds, setImportedStopIds] = useState<string[]>([]);
  const [optimizationResult, setOptimizationResult] = useState<OptimizationResult | null>(null);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [dispatched, setDispatched] = useState(false);

  const { data: vehicles } = useQuery<VehicleData[]>({
    queryKey: ["vehicles", ORG_ID],
    queryFn: async () => {
      const res = await fetch(`/api/vehicles?organizationId=${ORG_ID}`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: step >= 4,
  });

  const { data: drivers } = useQuery<DriverData[]>({
    queryKey: ["drivers", ORG_ID],
    queryFn: async () => {
      const res = await fetch(`/api/drivers?organizationId=${ORG_ID}`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: step >= 4,
  });

  const importMutation = useMutation({
    mutationFn: async (stops: Record<string, unknown>[]) => {
      const res = await fetch(`/api/stops/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: ORG_ID, stops }),
      });
      if (!res.ok) throw new Error("Import failed");
      return res.json();
    },
  });

  const stepLabels = [
    t("wizard.step1"),
    t("wizard.step2"),
    t("wizard.step3"),
    t("wizard.step4"),
    t("wizard.step5"),
    t("wizard.step6"),
  ];

  const fullReset = useCallback(() => {
    setStep(1);
    setParsedData(null);
    setMapping({});
    setMappedRows([]);
    setValidationErrors([]);
    setError(null);
    setFileName("");
    setSelectedVehicleIds([]);
    setImportedStopIds([]);
    setOptimizationResult(null);
    setIsOptimizing(false);
    setDispatched(false);
  }, []);

  const autoMatchColumns = useCallback((headers: string[]): ColumnMapping => {
    const result: ColumnMapping = {};
    for (const field of SYSTEM_FIELDS) { result[field.key] = null; }
    for (const header of headers) {
      const normalized = header.trim().toLowerCase().replace(/[\s\-\.]+/g, "_");
      const matchedField = ALIAS_MAP[normalized];
      if (matchedField && !result[matchedField]) { result[matchedField] = header; }
    }
    return result;
  }, []);

  const processFile = useCallback(
    (file: File) => {
      setError(null);
      setFileName(file.name);
      const isExcel = file.name.endsWith(".xlsx") || file.name.endsWith(".xls") || file.name.endsWith(".xlsb");
      if (isExcel) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const data = new Uint8Array(ev.target?.result as ArrayBuffer);
            const wb = xlsxRead(data, { type: "array" });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const jsonData: string[][] = xlsxUtils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
            if (jsonData.length < 2) { setError(t("import.needHeaderAndData")); return; }
            const headers = jsonData[0].map((h) => String(h).trim());
            const rows = jsonData.slice(1).filter((r) => r.some((c) => String(c).trim()));
            setParsedData({ headers, rows: rows.map((r) => r.map((c) => String(c))) });
            setMapping(autoMatchColumns(headers));
            setStep(2);
          } catch { setError(t("import.parseFailed")); }
        };
        reader.readAsArrayBuffer(file);
      } else {
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const text = ev.target?.result as string;
            const lines = text.trim().split("\n");
            if (lines.length < 2) { setError(t("import.needHeaderAndData")); return; }
            let delimiter = ",";
            if (lines[0].includes(";") && !lines[0].includes(",")) delimiter = ";";
            else if (lines[0].includes("\t") && !lines[0].includes(",")) delimiter = "\t";
            const headers = parseCsvLine(lines[0], delimiter);
            const rows = lines.slice(1).filter((l) => l.trim()).map((line) => parseCsvLine(line, delimiter));
            setParsedData({ headers, rows });
            setMapping(autoMatchColumns(headers));
            setStep(2);
          } catch { setError(t("import.parseFailed")); }
        };
        reader.readAsText(file);
      }
    },
    [t, autoMatchColumns],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  const isValidFile = useCallback((file: File) => {
    const ext = file.name.toLowerCase();
    return ext.endsWith(".csv") || ext.endsWith(".xlsx") || ext.endsWith(".xls") || ext.endsWith(".xlsb");
  }, []);

  const handlePageDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) setIsDraggingOver(true);
  }, []);
  const handlePageDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDraggingOver(false);
  }, []);
  const handlePageDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); }, []);
  const handlePageDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current = 0;
    setIsDraggingOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && isValidFile(file)) processFile(file);
  }, [isValidFile, processFile]);

  const updateMapping = useCallback((systemField: string, fileColumn: string | null) => {
    setMapping((prev) => ({ ...prev, [systemField]: fileColumn === "__none__" ? null : fileColumn }));
  }, []);

  const matchedCount = useMemo(() => Object.values(mapping).filter(Boolean).length, [mapping]);
  const requiredMapped = useMemo(
    () => SYSTEM_FIELDS.filter((f) => f.required).every((f) => mapping[f.key]),
    [mapping],
  );

  const handleApplyMapping = useCallback(() => {
    if (!parsedData) return;
    const errors: string[] = [];
    const rows: Record<string, string>[] = [];
    const getColIdx = (sf: string): number => {
      const colName = mapping[sf];
      return colName ? parsedData.headers.indexOf(colName) : -1;
    };
    for (let i = 0; i < parsedData.rows.length; i++) {
      const row = parsedData.rows[i];
      const addrIdx = getColIdx("address");
      const address = addrIdx >= 0 ? row[addrIdx]?.trim() : "";
      if (!address) { errors.push(t("import.rowMissingAddress", { row: i + 2 })); continue; }
      const mapped: Record<string, string> = {};
      for (const field of SYSTEM_FIELDS) {
        const idx = getColIdx(field.key);
        if (idx >= 0 && row[idx]?.trim()) mapped[field.key] = row[idx].trim();
      }
      rows.push(mapped);
    }
    setValidationErrors(errors);
    setMappedRows(rows);
    setStep(3);
  }, [parsedData, mapping, t]);

  const handleImportAndContinue = useCallback(() => {
    const stops = mappedRows.map((row) => {
      const stop: Record<string, unknown> = {
        address: row.address || "",
        latitude: row.latitude ? parseFloat(row.latitude.replace(",", ".")) : 0,
        longitude: row.longitude ? parseFloat(row.longitude.replace(",", ".")) : 0,
      };
      if (row.notes) stop.notes = row.notes;
      if (row.timeWindowStart) stop.timeWindowStart = row.timeWindowStart;
      if (row.timeWindowEnd) stop.timeWindowEnd = row.timeWindowEnd;
      if (row.serviceDurationMin) stop.serviceDurationMin = parseInt(row.serviceDurationMin);
      if (row.weightKg) stop.weightKg = parseFloat(row.weightKg.replace(",", "."));
      if (row.volumeM3) stop.volumeM3 = parseFloat(row.volumeM3.replace(",", "."));
      return stop;
    });
    importMutation.mutate(stops, {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
        if (data?.stops) setImportedStopIds(data.stops.map((s: any) => s.id));
        setStep(4);
      },
      onError: () => setError(t("import.importFailed")),
    });
  }, [mappedRows, importMutation, queryClient, t]);

  const toggleVehicle = useCallback((id: string) => {
    setSelectedVehicleIds((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]
    );
  }, []);

  const handleOptimize = useCallback(async () => {
    if (selectedVehicleIds.length === 0) return;
    setIsOptimizing(true);
    setError(null);
    try {
      const res = await fetch(`/api/optimize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: ORG_ID,
          vehicleIds: selectedVehicleIds,
          stopIds: importedStopIds.length > 0 ? importedStopIds : undefined,
          depotLatitude: 59.3293,
          depotLongitude: 18.0686,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Optimization failed");
      }
      const data = await res.json();
      setOptimizationResult(data);
      setStep(5);
    } catch (e: any) {
      setError(e.message || t("wizard.optimizeFailed"));
    } finally {
      setIsOptimizing(false);
    }
  }, [selectedVehicleIds, importedStopIds, t]);

  const handleDispatch = useCallback(async () => {
    setDispatched(true);
    setStep(6);
  }, []);

  return (
    <AppLayout>
      <div
        className="flex h-[calc(100vh-3.5rem)] overflow-hidden relative"
        onDragEnter={handlePageDragEnter}
        onDragLeave={handlePageDragLeave}
        onDragOver={handlePageDragOver}
        onDrop={handlePageDrop}
      >
        {isDraggingOver && (
          <div className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center pointer-events-none">
            <div className="border-2 border-dashed border-primary rounded-2xl p-16 text-center bg-primary/5">
              <Upload className="h-16 w-16 mx-auto text-primary mb-4 animate-bounce" />
              <p className="text-xl font-semibold text-primary">{t("import.dropFileHere")}</p>
              <p className="text-sm text-muted-foreground mt-2">{t("import.supportedFormats")}</p>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto p-6 md:p-8">
          <div className="max-w-5xl mx-auto">
            <div className="mb-8">
              <h1 className="text-2xl font-bold">{t("wizard.title")}</h1>
              <p className="text-muted-foreground mt-1">{t("wizard.subtitle")}</p>
            </div>

            <div className="mb-8">
              <div className="flex items-center gap-0">
                {stepLabels.map((label, idx) => {
                  const stepNum = (idx + 1) as WizardStep;
                  const Icon = STEP_ICONS[idx];
                  const isActive = step === stepNum;
                  const isDone = step > stepNum;
                  return (
                    <div key={idx} className="flex items-center flex-1 last:flex-none">
                      <div className="flex flex-col items-center">
                        <div
                          className={cn(
                            "w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold transition-all duration-300 shrink-0",
                            isDone
                              ? "bg-primary text-primary-foreground"
                              : isActive
                                ? "bg-primary/20 text-primary ring-2 ring-primary ring-offset-2 ring-offset-background"
                                : "bg-muted text-muted-foreground"
                          )}
                        >
                          {isDone ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                        </div>
                        <span className={cn(
                          "text-[10px] mt-1.5 font-medium text-center leading-tight w-16",
                          isActive ? "text-primary" : isDone ? "text-foreground" : "text-muted-foreground"
                        )}>
                          {label}
                        </span>
                      </div>
                      {idx < 5 && (
                        <div className={cn(
                          "h-0.5 flex-1 mx-1 mt-[-16px] transition-colors",
                          isDone ? "bg-primary" : "bg-muted"
                        )} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {step === 1 && (
              <div className="space-y-4">
                <div className="rounded-xl border border-border bg-card p-6">
                  <div
                    className={cn(
                      "border-2 border-dashed rounded-xl p-10 text-center transition-all duration-200 cursor-pointer",
                      localDrag ? "border-primary bg-primary/5 scale-[1.01]" : "border-border hover:border-primary/50"
                    )}
                    onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); localDragCounter.current++; setLocalDrag(true); }}
                    onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); localDragCounter.current--; if (localDragCounter.current === 0) setLocalDrag(false); }}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); localDragCounter.current = 0; setLocalDrag(false); const file = e.dataTransfer.files?.[0]; if (file) processFile(file); }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className={cn("h-12 w-12 mx-auto mb-4 transition-colors", localDrag ? "text-primary" : "text-muted-foreground")} />
                    <p className="font-medium mb-1">{t("import.dragOrClick")}</p>
                    <p className="text-xs text-muted-foreground mb-4">{t("import.supportedFormats")}</p>
                    <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls,.xlsb" onChange={handleFileChange} className="hidden" />
                    <span
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <FileSpreadsheet className="h-4 w-4" />
                      {t("import.selectFile")}
                    </span>
                    {fileName && <p className="mt-3 text-sm text-muted-foreground">{fileName}</p>}
                  </div>
                  {error && (
                    <div className="mt-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      {error}
                    </div>
                  )}
                </div>
                <div className="p-4 rounded-xl border border-border bg-card">
                  <h3 className="font-semibold text-sm mb-2">{t("importPage.excelTemplate")}</h3>
                  <p className="text-xs text-muted-foreground mb-3">{t("importPage.excelTemplateDesc")}</p>
                  <Button variant="outline" size="sm" className="gap-2" onClick={() => downloadTemplate()}>
                    <FileDown className="h-4 w-4" />
                    {t("importPage.downloadTemplate")}
                  </Button>
                </div>
              </div>
            )}

            {step === 2 && parsedData && (
              <div className="rounded-xl border border-border bg-card p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-sm">{t("import.matchColumns")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("import.matchedCount", { count: matchedCount, total: SYSTEM_FIELDS.length })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="w-2 h-2 rounded-full bg-destructive" />
                    {t("import.required")}
                    <span className="w-2 h-2 rounded-full bg-muted-foreground ml-2" />
                    {t("import.optional")}
                  </div>
                </div>

                <div className="rounded-lg border border-border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="p-2.5 text-left text-xs font-semibold text-muted-foreground w-[5%]">#</th>
                        <th className="p-2.5 text-left text-xs font-semibold text-muted-foreground w-[35%]">{t("import.systemField")}</th>
                        <th className="p-2.5 text-center w-[5%]"><ArrowRight className="h-4 w-4 mx-auto text-muted-foreground" /></th>
                        <th className="p-2.5 text-left text-xs font-semibold text-muted-foreground w-[55%]">{t("import.fileColumn")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {SYSTEM_FIELDS.map((field, idx) => {
                        const mapped = mapping[field.key];
                        const colIdx = mapped ? parsedData.headers.indexOf(mapped) : -1;
                        const sampleValue = colIdx >= 0 && parsedData.rows[0] ? parsedData.rows[0][colIdx] : null;
                        return (
                          <tr key={field.key} className={cn("transition-colors", mapped ? "bg-primary/5" : (field.required ? "bg-destructive/5" : ""))}>
                            <td className="p-2.5 font-bold text-xs">{idx + 1}</td>
                            <td className="p-2.5">
                              <div className="flex items-center gap-2">
                                <span className={cn("w-2 h-2 rounded-full shrink-0", field.required ? "bg-destructive" : "bg-muted-foreground")} />
                                <span className="font-medium text-xs">{t(field.labelKey)}</span>
                                {mapped && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                              </div>
                            </td>
                            <td className="p-2.5 text-center">
                              <ArrowRight className={cn("h-3.5 w-3.5 mx-auto", mapped ? "text-primary" : "text-muted-foreground/30")} />
                            </td>
                            <td className="p-2.5">
                              <Select value={mapped || "__none__"} onValueChange={(val) => updateMapping(field.key, val)}>
                                <SelectTrigger className="h-8 text-xs">
                                  <SelectValue placeholder={t("import.selectColumn")} />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none__"><span className="text-muted-foreground">— {t("import.skip")} —</span></SelectItem>
                                  {parsedData.headers.map((h) => (<SelectItem key={h} value={h}>{h}</SelectItem>))}
                                </SelectContent>
                              </Select>
                              {sampleValue && <p className="text-[10px] text-muted-foreground mt-1 truncate">{t("import.example")}: {sampleValue}</p>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="flex justify-between pt-2">
                  <Button variant="outline" size="sm" onClick={fullReset} className="gap-1">
                    <ChevronLeft className="h-4 w-4" /> {t("common.back")}
                  </Button>
                  <Button size="sm" onClick={handleApplyMapping} disabled={!requiredMapped} className="gap-1">
                    {t("wizard.next")} <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="rounded-xl border border-border bg-card p-6 space-y-4">
                <div className="flex items-center gap-3 mb-2">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary/10">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      <span className="text-sm font-semibold text-primary">{mappedRows.length} {t("wizard.validRows")}</span>
                    </div>
                    {validationErrors.length > 0 && (
                      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-destructive/10">
                        <XCircle className="h-4 w-4 text-destructive" />
                        <span className="text-sm font-semibold text-destructive">{validationErrors.length} {t("wizard.errorRows")}</span>
                      </div>
                    )}
                  </div>
                </div>

                {validationErrors.length > 0 && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
                    <p className="text-xs font-semibold text-amber-500 flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {t("wizard.skippedDetail")}
                    </p>
                    <div className="max-h-24 overflow-auto">
                      {validationErrors.map((err, i) => (
                        <p key={i} className="text-xs text-muted-foreground">{err}</p>
                      ))}
                    </div>
                  </div>
                )}

                <div className="rounded-lg border border-border overflow-auto max-h-[350px]">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="p-2 text-left font-semibold text-muted-foreground">#</th>
                        {SYSTEM_FIELDS.filter(f => mappedRows.some(r => r[f.key])).map(f => (
                          <th key={f.key} className="p-2 text-left font-semibold text-muted-foreground whitespace-nowrap">{t(f.labelKey)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {mappedRows.slice(0, 25).map((row, i) => (
                        <tr key={i} className="hover:bg-muted/30">
                          <td className="p-2 font-medium">{i + 1}</td>
                          {SYSTEM_FIELDS.filter(f => mappedRows.some(r => r[f.key])).map(f => (
                            <td key={f.key} className="p-2 max-w-[200px] truncate">{row[f.key] || ""}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {mappedRows.length > 25 && (
                  <p className="text-xs text-muted-foreground text-center">
                    {t("wizard.showingOf", { shown: 25, total: mappedRows.length })}
                  </p>
                )}

                {error && (
                  <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{error}
                  </div>
                )}

                <div className="flex justify-between pt-2">
                  <Button variant="outline" size="sm" onClick={() => setStep(2)} className="gap-1">
                    <ChevronLeft className="h-4 w-4" /> {t("common.back")}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleImportAndContinue}
                    disabled={importMutation.isPending || mappedRows.length === 0}
                    className="gap-1"
                  >
                    {importMutation.isPending ? (
                      <><Loader2 className="h-4 w-4 animate-spin" /> {t("import.importing")}</>
                    ) : (
                      <>{t("wizard.importAndContinue")} <ChevronRight className="h-4 w-4" /></>
                    )}
                  </Button>
                </div>
              </div>
            )}

            {step === 4 && (
              <div className="rounded-xl border border-border bg-card p-6 space-y-4">
                <div>
                  <h2 className="font-semibold text-lg flex items-center gap-2">
                    <Truck className="h-5 w-5 text-primary" />
                    {t("wizard.selectVehicles")}
                  </h2>
                  <p className="text-sm text-muted-foreground mt-1">{t("wizard.selectVehiclesDesc")}</p>
                </div>

                {!vehicles || vehicles.length === 0 ? (
                  <div className="text-center py-8">
                    <Truck className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
                    <p className="text-sm text-muted-foreground">{t("wizard.noVehicles")}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {vehicles.filter(v => v.isActive).map((v) => {
                      const selected = selectedVehicleIds.includes(v.id);
                      const driver = drivers?.find(d => d.vehicleId === v.id);
                      return (
                        <button
                          key={v.id}
                          onClick={() => toggleVehicle(v.id)}
                          className={cn(
                            "p-4 rounded-xl border-2 text-left transition-all",
                            selected
                              ? "border-primary bg-primary/5"
                              : "border-border hover:border-primary/30"
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <div className={cn(
                                "w-8 h-8 rounded-lg flex items-center justify-center",
                                selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                              )}>
                                <Truck className="h-4 w-4" />
                              </div>
                              <div>
                                <p className="font-medium text-sm">{v.name}</p>
                                <p className="text-xs text-muted-foreground">{v.licensePlate}</p>
                              </div>
                            </div>
                            {selected && <Check className="h-5 w-5 text-primary" />}
                          </div>
                          {driver && (
                            <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Users className="h-3 w-3" />
                              {driver.name}
                            </div>
                          )}
                          <div className="mt-1 text-xs text-muted-foreground">
                            {t("wizard.capacity")}: {v.capacityKg} kg
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {error && (
                  <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{error}
                  </div>
                )}

                <div className="flex justify-between pt-2">
                  <Button variant="outline" size="sm" onClick={() => setStep(3)} className="gap-1">
                    <ChevronLeft className="h-4 w-4" /> {t("common.back")}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleOptimize}
                    disabled={selectedVehicleIds.length === 0 || isOptimizing}
                    className="gap-1"
                  >
                    {isOptimizing ? (
                      <><Loader2 className="h-4 w-4 animate-spin" /> {t("wizard.optimizing")}</>
                    ) : (
                      <><Cpu className="h-4 w-4" /> {t("wizard.optimizeRoutes")}</>
                    )}
                  </Button>
                </div>
              </div>
            )}

            {step === 5 && (
              <div className="rounded-xl border border-border bg-card p-6 space-y-4">
                <div>
                  <h2 className="font-semibold text-lg flex items-center gap-2">
                    <Zap className="h-5 w-5 text-primary" />
                    {t("wizard.optimizationResult")}
                  </h2>
                </div>

                {optimizationResult ? (
                  <>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="p-4 rounded-xl bg-muted/50 text-center">
                        <p className="text-2xl font-bold">{optimizationResult.totalDistanceKm?.toFixed(1) ?? "—"} km</p>
                        <p className="text-xs text-muted-foreground mt-1">{t("wizard.totalDistance")}</p>
                      </div>
                      <div className="p-4 rounded-xl bg-muted/50 text-center">
                        <p className="text-2xl font-bold">{optimizationResult.totalDurationMin?.toFixed(0) ?? "—"} min</p>
                        <p className="text-xs text-muted-foreground mt-1">{t("wizard.totalTime")}</p>
                      </div>
                      <div className="p-4 rounded-xl bg-muted/50 text-center">
                        <p className="text-2xl font-bold">{optimizationResult.costBreakdown?.totalCo2Kg?.toFixed(1) ?? "—"} kg</p>
                        <p className="text-xs text-muted-foreground mt-1">CO₂</p>
                      </div>
                    </div>

                    <div className="space-y-3">
                      {optimizationResult.routes?.map((route, idx) => {
                        const vehicle = vehicles?.find(v => v.id === route.vehicleId);
                        return (
                          <div key={idx} className="rounded-lg border border-border p-4">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <Truck className="h-4 w-4 text-primary" />
                                <span className="font-medium text-sm">{vehicle?.name ?? route.vehicleId.slice(0, 8)}</span>
                                {vehicle && <span className="text-xs text-muted-foreground">({vehicle.licensePlate})</span>}
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {route.stops?.length ?? 0} {t("wizard.stops")} · {route.distanceKm?.toFixed(1)} km
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {route.stops?.slice(0, 8).map((s, i) => (
                                <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground">
                                  #{s.sequenceOrder}
                                </span>
                              ))}
                              {(route.stops?.length ?? 0) > 8 && (
                                <span className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground">
                                  +{(route.stops?.length ?? 0) - 8}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <div className="text-center py-8">
                    <Info className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">{t("wizard.noOptResult")}</p>
                  </div>
                )}

                <div className="flex justify-between pt-2">
                  <Button variant="outline" size="sm" onClick={() => setStep(4)} className="gap-1">
                    <ChevronLeft className="h-4 w-4" /> {t("common.back")}
                  </Button>
                  <Button size="sm" onClick={handleDispatch} className="gap-1">
                    <Smartphone className="h-4 w-4" /> {t("wizard.sendToDrivers")}
                  </Button>
                </div>
              </div>
            )}

            {step === 6 && (
              <div className="rounded-xl border border-border bg-card p-8 text-center space-y-4">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                  <CheckCircle2 className="h-8 w-8 text-primary" />
                </div>
                <h2 className="text-xl font-bold">{t("wizard.done")}</h2>
                <p className="text-muted-foreground max-w-md mx-auto">{t("wizard.doneDesc")}</p>
                <div className="flex items-center justify-center gap-3 pt-4">
                  <Button variant="outline" onClick={fullReset} className="gap-2">
                    <Upload className="h-4 w-4" />
                    {t("wizard.newImport")}
                  </Button>
                  <Button onClick={() => { window.location.href = import.meta.env.BASE_URL.replace(/\/$/, "") + "/map"; }} className="gap-2">
                    <Smartphone className="h-4 w-4" />
                    {t("wizard.goToMap")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
