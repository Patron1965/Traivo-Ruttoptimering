import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Copy,
  FileDown,
  Plug,
  GripVertical,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ORG_ID } from "@/lib/constants";
import { read as xlsxRead, utils as xlsxUtils } from "xlsx";
import { useMutation } from "@tanstack/react-query";

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
  referensnummer: "referenceNumber",
  reference: "referenceNumber",
  reference_number: "referenceNumber",
  ref: "referenceNumber",
  ordernummer: "referenceNumber",
  order_number: "referenceNumber",
  ordernr: "referenceNumber",

  datum: "date",
  date: "date",
  leveransdatum: "date",
  delivery_date: "date",

  namn: "contactName",
  name: "contactName",
  contact_name: "contactName",
  kontaktnamn: "contactName",
  mottagare: "contactName",
  recipient: "contactName",
  customer_name: "contactName",
  kundnamn: "contactName",

  telefonnummer: "contactPhone",
  telefon: "contactPhone",
  phone: "contactPhone",
  tel: "contactPhone",
  contact_phone: "contactPhone",
  mobilnummer: "contactPhone",
  mobil: "contactPhone",
  mobile: "contactPhone",

  epost: "contactEmail",
  "e-post": "contactEmail",
  email: "contactEmail",
  mail: "contactEmail",
  contact_email: "contactEmail",

  address: "address",
  adress: "address",
  gatuadress: "address",
  street: "address",
  street_address: "address",
  leveransadress: "address",
  delivery_address: "address",

  latitude: "latitude",
  lat: "latitude",
  latitud: "latitude",
  delivery_latitude: "latitude",

  longitude: "longitude",
  lng: "longitude",
  lon: "longitude",
  long: "longitude",
  longitud: "longitude",
  delivery_longitude: "longitude",

  leverans_från_kl: "timeWindowStart",
  "leverans från kl": "timeWindowStart",
  time_window_start: "timeWindowStart",
  start_time: "timeWindowStart",
  starttid: "timeWindowStart",
  från: "timeWindowStart",

  leverans_till_kl: "timeWindowEnd",
  "leverans till kl": "timeWindowEnd",
  time_window_end: "timeWindowEnd",
  end_time: "timeWindowEnd",
  sluttid: "timeWindowEnd",
  till: "timeWindowEnd",

  servicetid: "serviceDurationMin",
  service_duration_min: "serviceDurationMin",
  duration: "serviceDurationMin",
  minuter: "serviceDurationMin",

  vikt: "weightKg",
  weight: "weightKg",
  weight_kg: "weightKg",
  kg: "weightKg",

  volym: "volumeM3",
  volume: "volumeM3",
  volume_m3: "volumeM3",
  m3: "volumeM3",

  notering: "notes",
  notes: "notes",
  anteckning: "notes",
  kommentar: "notes",
  comment: "notes",
  beskrivning: "notes",
  description: "notes",
};

type Tab = "fields" | "upload" | "api";

type Step = "upload" | "mapping" | "preview";

interface ParsedData {
  headers: string[];
  rows: string[][];
}

interface ColumnMapping {
  [systemField: string]: string | null;
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

export default function Import() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>("fields");
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);

  const copyToClipboard = useCallback((text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSnippet(id);
    setTimeout(() => setCopiedSnippet(null), 2000);
  }, []);

  const tabs: { key: Tab; labelKey: string; icon: typeof FileSpreadsheet }[] = [
    { key: "fields", labelKey: "importPage.tabs.fields", icon: GripVertical },
    { key: "upload", labelKey: "importPage.tabs.upload", icon: Upload },
    { key: "api", labelKey: "importPage.tabs.api", icon: Plug },
  ];

  return (
    <AppLayout>
      <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
        <div className="flex-1 overflow-auto p-6 md:p-8">
          <div className="max-w-5xl mx-auto">
            <div className="mb-6">
              <h1 className="text-2xl font-bold">{t("importPage.title")}</h1>
              <p className="text-muted-foreground mt-1">{t("importPage.subtitle")}</p>
            </div>

            <div className="flex gap-1 p-1 bg-muted/50 rounded-xl mb-6 w-fit">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
                    activeTab === tab.key
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <tab.icon className="h-4 w-4" />
                  {t(tab.labelKey)}
                </button>
              ))}
            </div>

            {activeTab === "fields" && (
              <FieldDefinitions />
            )}

            {activeTab === "upload" && (
              <FileUploadSection />
            )}

            {activeTab === "api" && (
              <ApiDocumentation copiedSnippet={copiedSnippet} onCopy={copyToClipboard} />
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function FieldDefinitions() {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-xl border border-border bg-card">
        <div className="flex items-start gap-3 mb-4">
          <Info className="h-5 w-5 text-primary mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-sm">{t("importPage.fieldsInfo")}</p>
            <p className="text-xs text-muted-foreground mt-1">{t("importPage.fieldsInfoDesc")}</p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border overflow-hidden bg-card">
        <div className="grid grid-cols-[auto_1fr_auto_1fr_1fr] gap-0 text-sm">
          <div className="contents">
            <div className="p-3 bg-muted/60 font-semibold text-xs text-muted-foreground border-b border-border">#</div>
            <div className="p-3 bg-muted/60 font-semibold text-xs text-muted-foreground border-b border-border">{t("importPage.fieldName")}</div>
            <div className="p-3 bg-muted/60 font-semibold text-xs text-muted-foreground border-b border-border"></div>
            <div className="p-3 bg-muted/60 font-semibold text-xs text-muted-foreground border-b border-border">{t("importPage.apiFieldName")}</div>
            <div className="p-3 bg-muted/60 font-semibold text-xs text-muted-foreground border-b border-border">{t("importPage.exampleValue")}</div>
          </div>

          {SYSTEM_FIELDS.map((field, idx) => (
            <div key={field.key} className="contents group">
              <div className="p-3 border-b border-border font-bold text-foreground flex items-center">
                {idx + 1}
              </div>
              <div className="p-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{t(field.labelKey)}</span>
                  <span className={cn(
                    "inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium",
                    field.required
                      ? "bg-destructive/10 text-destructive"
                      : "bg-primary/10 text-primary"
                  )}>
                    {field.required ? t("importPage.requiredBadge") : t("importPage.optionalBadge")}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{t(field.description)}</p>
              </div>
              <div className="p-3 border-b border-border flex items-center">
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/40" />
              </div>
              <div className="p-3 border-b border-border flex items-center">
                <code className="text-xs bg-muted/60 px-2 py-1 rounded font-mono">{field.apiField}</code>
              </div>
              <div className="p-3 border-b border-border flex items-center">
                <span className="text-xs text-muted-foreground italic">{field.exampleValue}</span>
              </div>
            </div>
          ))}
        </div>
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
  );
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

function FileUploadSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("upload");
  const [parsedData, setParsedData] = useState<ParsedData | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [mappedRows, setMappedRows] = useState<Record<string, string>[]>([]);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");

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

  const reset = useCallback(() => {
    setStep("upload");
    setParsedData(null);
    setMapping({});
    setMappedRows([]);
    setValidationErrors([]);
    setError(null);
    setFileName("");
  }, []);

  const autoMatchColumns = useCallback((headers: string[]): ColumnMapping => {
    const result: ColumnMapping = {};
    for (const field of SYSTEM_FIELDS) {
      result[field.key] = null;
    }
    for (const header of headers) {
      const normalized = header.trim().toLowerCase().replace(/[\s\-\.]+/g, "_");
      const matchedField = ALIAS_MAP[normalized];
      if (matchedField && !result[matchedField]) {
        result[matchedField] = header;
      }
    }
    return result;
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setError(null);
      const file = e.target.files?.[0];
      if (!file) return;
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
            setStep("mapping");
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
            setStep("mapping");
          } catch { setError(t("import.parseFailed")); }
        };
        reader.readAsText(file);
      }
    },
    [t, autoMatchColumns],
  );

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

    const getColIdx = (systemField: string): number => {
      const colName = mapping[systemField];
      if (!colName) return -1;
      return parsedData.headers.indexOf(colName);
    };

    for (let i = 0; i < parsedData.rows.length; i++) {
      const row = parsedData.rows[i];
      const addrIdx = getColIdx("address");
      const address = addrIdx >= 0 ? row[addrIdx]?.trim() : "";

      if (!address) {
        errors.push(t("import.rowMissingAddress", { row: i + 2 }));
        continue;
      }

      const mapped: Record<string, string> = {};
      for (const field of SYSTEM_FIELDS) {
        const idx = getColIdx(field.key);
        if (idx >= 0 && row[idx]?.trim()) {
          mapped[field.key] = row[idx].trim();
        }
      }
      rows.push(mapped);
    }

    setValidationErrors(errors);
    setMappedRows(rows);
    setStep("preview");
  }, [parsedData, mapping, t]);

  const handleImport = useCallback(() => {
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
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
        reset();
      },
      onError: () => setError(t("import.importFailed")),
    });
  }, [mappedRows, importMutation, queryClient, reset, t]);

  return (
    <div className="space-y-4">
      {step === "upload" && (
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="border-2 border-dashed border-border rounded-xl p-10 text-center hover:border-primary/50 transition-colors">
            <Upload className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="font-medium mb-1">{t("import.dragOrClick")}</p>
            <p className="text-xs text-muted-foreground mb-4">{t("import.supportedFormats")}</p>
            <Label className="cursor-pointer">
              <Input type="file" accept=".csv,.xlsx,.xls,.xlsb" onChange={handleFileChange} className="hidden" />
              <span className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer">
                <FileSpreadsheet className="h-4 w-4" />
                {t("import.selectFile")}
              </span>
            </Label>
            {fileName && <p className="mt-3 text-sm text-muted-foreground">{fileName}</p>}
          </div>
          {error && (
            <div className="mt-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              {error}
            </div>
          )}
        </div>
      )}

      {step === "mapping" && parsedData && (
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
            <Button variant="outline" size="sm" onClick={() => { reset(); }} className="gap-1">
              <ChevronLeft className="h-4 w-4" /> {t("common.back")}
            </Button>
            <Button size="sm" onClick={handleApplyMapping} disabled={!requiredMapped} className="gap-1">
              {t("import.preview")} <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="rounded-xl border border-border bg-card p-6 space-y-4">
          <div>
            <p className="font-medium text-sm">
              {t("import.readyToImport", { count: mappedRows.length })}
            </p>
            {validationErrors.length > 0 && (
              <p className="text-xs text-amber-500 mt-1">
                {t("import.skippedRows", { count: validationErrors.length })}
              </p>
            )}
          </div>

          <div className="rounded-lg border border-border overflow-auto max-h-[400px]">
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
                {mappedRows.slice(0, 20).map((row, i) => (
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

          {error && (
            <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              {error}
            </div>
          )}

          <div className="flex justify-between pt-2">
            <Button variant="outline" size="sm" onClick={() => setStep("mapping")} className="gap-1">
              <ChevronLeft className="h-4 w-4" /> {t("import.backToMapping")}
            </Button>
            <Button size="sm" onClick={handleImport} disabled={importMutation.isPending || mappedRows.length === 0} className="gap-1">
              {importMutation.isPending ? t("import.importing") : t("import.importCount", { count: mappedRows.length })}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ApiDocumentation({
  copiedSnippet,
  onCopy,
}: {
  copiedSnippet: string | null;
  onCopy: (text: string, id: string) => void;
}) {
  const { t } = useTranslation();

  const importExample = `POST /api/stops/import
Content-Type: application/json

{
  "organizationId": "${ORG_ID}",
  "stops": [
    {
      "address": "Storgatan 12, Stockholm",
      "latitude": 59.3293,
      "longitude": 18.0686,
      "timeWindowStart": "2026-04-10T08:00:00Z",
      "timeWindowEnd": "2026-04-10T12:00:00Z",
      "serviceDurationMin": 15,
      "weightKg": 25.5,
      "notes": "Portkod 1234"
    }
  ]
}`;

  const webhookExample = `POST /api/webhooks
Content-Type: application/json

{
  "organizationId": "${ORG_ID}",
  "url": "https://ert-system.example.com/traivo-webhook",
  "events": [
    "route.optimized",
    "route.completed",
    "stop.completed",
    "stop.failed"
  ],
  "name": "ERP Webhook"
}`;

  const webhookPayload = `{
  "event": "stop.completed",
  "timestamp": "2026-04-10T14:32:00Z",
  "data": {
    "stopId": "abc-123",
    "routeId": "route-456",
    "address": "Storgatan 12, Stockholm",
    "status": "completed",
    "completedAt": "2026-04-10T14:30:00Z"
  }
}`;

  const exportExample = `GET /api/routes/{routeId}/export

Svar: CSV-fil med alla stopp i rutten
(Referens, Adress, Koordinater, Tidsfönster, Status)`;

  const listStopsExample = `GET /api/stops?organizationId=${ORG_ID}&status=completed

Svar: JSON-array med alla stopp som har angiven status`;

  return (
    <div className="space-y-6">
      <div className="p-4 rounded-xl border border-border bg-card">
        <div className="flex items-start gap-3">
          <Plug className="h-5 w-5 text-primary mt-0.5 shrink-0" />
          <div>
            <h2 className="font-semibold">{t("importPage.api.title")}</h2>
            <p className="text-sm text-muted-foreground mt-1">{t("importPage.api.subtitle")}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-6">
        <ApiSection
          title={t("importPage.api.importTitle")}
          description={t("importPage.api.importDesc")}
          method="POST"
          endpoint="/api/stops/import"
          code={importExample}
          copiedSnippet={copiedSnippet}
          onCopy={onCopy}
          id="import"
        />

        <ApiSection
          title={t("importPage.api.webhookTitle")}
          description={t("importPage.api.webhookDesc")}
          method="POST"
          endpoint="/api/webhooks"
          code={webhookExample}
          copiedSnippet={copiedSnippet}
          onCopy={onCopy}
          id="webhook"
        />

        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="p-4 border-b border-border">
            <h3 className="font-semibold text-sm">{t("importPage.api.webhookPayloadTitle")}</h3>
            <p className="text-xs text-muted-foreground mt-1">{t("importPage.api.webhookPayloadDesc")}</p>
          </div>
          <div className="relative">
            <pre className="p-4 text-xs font-mono overflow-auto bg-zinc-950 text-zinc-300 max-h-[300px]">{webhookPayload}</pre>
            <button
              onClick={() => onCopy(webhookPayload, "payload")}
              className="absolute top-3 right-3 p-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
            >
              {copiedSnippet === "payload" ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
          <div className="p-4 border-t border-border">
            <p className="text-xs text-muted-foreground">
              <strong>{t("importPage.api.events")}:</strong> route.optimized, route.started, route.completed, route.cancelled, stop.completed, stop.failed
            </p>
          </div>
        </div>

        <ApiSection
          title={t("importPage.api.exportTitle")}
          description={t("importPage.api.exportDesc")}
          method="GET"
          endpoint="/api/routes/{id}/export"
          code={exportExample}
          copiedSnippet={copiedSnippet}
          onCopy={onCopy}
          id="export"
        />

        <ApiSection
          title={t("importPage.api.listStopsTitle")}
          description={t("importPage.api.listStopsDesc")}
          method="GET"
          endpoint="/api/stops"
          code={listStopsExample}
          copiedSnippet={copiedSnippet}
          onCopy={onCopy}
          id="list"
        />
      </div>

      <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/5">
        <div className="flex items-start gap-3">
          <Info className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
          <div>
            <h3 className="font-semibold text-sm">{t("importPage.api.flowTitle")}</h3>
            <div className="mt-2 space-y-2 text-sm text-muted-foreground">
              <p><strong>1.</strong> {t("importPage.api.flow1")}</p>
              <p><strong>2.</strong> {t("importPage.api.flow2")}</p>
              <p><strong>3.</strong> {t("importPage.api.flow3")}</p>
              <p><strong>4.</strong> {t("importPage.api.flow4")}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ApiSection({
  title,
  description,
  method,
  endpoint,
  code,
  copiedSnippet,
  onCopy,
  id,
}: {
  title: string;
  description: string;
  method: string;
  endpoint: string;
  code: string;
  copiedSnippet: string | null;
  onCopy: (text: string, id: string) => void;
  id: string;
}) {
  const methodColor = method === "POST" ? "bg-green-500/10 text-green-500" : method === "GET" ? "bg-blue-500/10 text-blue-500" : "bg-amber-500/10 text-amber-500";

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="p-4 border-b border-border">
        <div className="flex items-center gap-2 mb-1">
          <span className={cn("px-2 py-0.5 rounded text-[10px] font-bold uppercase", methodColor)}>{method}</span>
          <code className="text-xs font-mono text-muted-foreground">{endpoint}</code>
        </div>
        <h3 className="font-semibold text-sm mt-2">{title}</h3>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </div>
      <div className="relative">
        <pre className="p-4 text-xs font-mono overflow-auto bg-zinc-950 text-zinc-300 max-h-[300px]">{code}</pre>
        <button
          onClick={() => onCopy(code, id)}
          className="absolute top-3 right-3 p-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
        >
          {copiedSnippet === id ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}
