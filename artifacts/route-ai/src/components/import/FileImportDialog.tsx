import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useImportStops } from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";
import { read as xlsxRead, utils as xlsxUtils } from "xlsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
} from "lucide-react";
import { cn } from "@/lib/utils";

type SystemField = {
  key: string;
  labelKey: string;
  required: boolean;
};

const SYSTEM_FIELDS: SystemField[] = [
  { key: "address", labelKey: "import.field.address", required: true },
  { key: "latitude", labelKey: "import.field.latitude", required: true },
  { key: "longitude", labelKey: "import.field.longitude", required: true },
  { key: "notes", labelKey: "import.field.notes", required: false },
  { key: "timeWindowStart", labelKey: "import.field.timeWindowStart", required: false },
  { key: "timeWindowEnd", labelKey: "import.field.timeWindowEnd", required: false },
  { key: "serviceDurationMin", labelKey: "import.field.serviceDurationMin", required: false },
  { key: "weightKg", labelKey: "import.field.weightKg", required: false },
  { key: "volumeM3", labelKey: "import.field.volumeM3", required: false },
];

const ALIAS_MAP: Record<string, string> = {
  address: "address",
  adress: "address",
  gatuadress: "address",
  street: "address",
  street_address: "address",
  streetaddress: "address",
  location: "address",
  plats: "address",
  leveransadress: "address",
  delivery_address: "address",
  deliveryaddress: "address",

  latitude: "latitude",
  lat: "latitude",
  latitud: "latitude",
  breddgrad: "latitude",

  longitude: "longitude",
  lng: "longitude",
  lon: "longitude",
  long: "longitude",
  longitud: "longitude",
  längdgrad: "longitude",
  langdgrad: "longitude",

  notes: "notes",
  note: "notes",
  notering: "notes",
  noteringar: "notes",
  anteckning: "notes",
  anteckningar: "notes",
  comment: "notes",
  comments: "notes",
  kommentar: "notes",
  kommentarer: "notes",
  beskrivning: "notes",
  description: "notes",
  info: "notes",
  information: "notes",

  time_window_start: "timeWindowStart",
  timewindowstart: "timeWindowStart",
  start_time: "timeWindowStart",
  starttime: "timeWindowStart",
  starttid: "timeWindowStart",
  från: "timeWindowStart",
  fran: "timeWindowStart",
  from: "timeWindowStart",
  tidsfönster_start: "timeWindowStart",
  tidsfonster_start: "timeWindowStart",
  earliest: "timeWindowStart",
  earliest_time: "timeWindowStart",

  time_window_end: "timeWindowEnd",
  timewindowend: "timeWindowEnd",
  end_time: "timeWindowEnd",
  endtime: "timeWindowEnd",
  sluttid: "timeWindowEnd",
  till: "timeWindowEnd",
  to: "timeWindowEnd",
  tidsfönster_slut: "timeWindowEnd",
  tidsfonster_slut: "timeWindowEnd",
  latest: "timeWindowEnd",
  latest_time: "timeWindowEnd",

  service_duration_min: "serviceDurationMin",
  servicedurationmin: "serviceDurationMin",
  service_duration: "serviceDurationMin",
  serviceduration: "serviceDurationMin",
  duration: "serviceDurationMin",
  duration_min: "serviceDurationMin",
  servicetid: "serviceDurationMin",
  tid_min: "serviceDurationMin",
  minutes: "serviceDurationMin",
  minuter: "serviceDurationMin",

  weight_kg: "weightKg",
  weightkg: "weightKg",
  weight: "weightKg",
  vikt: "weightKg",
  vikt_kg: "weightKg",
  kg: "weightKg",
  mass: "weightKg",

  volume_m3: "volumeM3",
  volumem3: "volumeM3",
  volume: "volumeM3",
  volym: "volumeM3",
  volym_m3: "volumeM3",
  m3: "volumeM3",
  cbm: "volumeM3",
};

function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === delimiter) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
  }
  result.push(current.trim());
  return result;
}

type Step = "upload" | "mapping" | "preview";

interface ParsedData {
  headers: string[];
  rows: string[][];
  sheetName?: string;
}

interface ColumnMapping {
  [systemField: string]: string | null;
}

interface MappedRow {
  address: string;
  latitude: number;
  longitude: number;
  notes?: string;
  timeWindowStart?: string;
  timeWindowEnd?: string;
  serviceDurationMin?: number;
  weightKg?: number;
  volumeM3?: number;
}

interface FileImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function FileImportDialog({ open, onOpenChange, onSuccess }: FileImportDialogProps) {
  const { t } = useTranslation();
  const importMutation = useImportStops();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>("upload");
  const [parsedData, setParsedData] = useState<ParsedData | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [mappedRows, setMappedRows] = useState<MappedRow[]>([]);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");

  const reset = useCallback(() => {
    setStep("upload");
    setParsedData(null);
    setMapping({});
    setMappedRows([]);
    setValidationErrors([]);
    setError(null);
    setFileName("");
  }, []);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) reset();
      onOpenChange(open);
    },
    [onOpenChange, reset],
  );

  const autoMatchColumns = useCallback((headers: string[]): ColumnMapping => {
    const result: ColumnMapping = {};
    const usedHeaders = new Set<string>();

    for (const field of SYSTEM_FIELDS) {
      result[field.key] = null;
    }

    for (const header of headers) {
      const normalized = header.trim().toLowerCase().replace(/[\s\-\.]+/g, "_");
      const matchedField = ALIAS_MAP[normalized];
      if (matchedField && !result[matchedField]) {
        result[matchedField] = header;
        usedHeaders.add(header);
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

      const isExcel =
        file.name.endsWith(".xlsx") ||
        file.name.endsWith(".xls") ||
        file.name.endsWith(".xlsb");

      if (isExcel) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const data = new Uint8Array(ev.target?.result as ArrayBuffer);
            const wb = xlsxRead(data, { type: "array" });
            const sheetName = wb.SheetNames[0];
            const ws = wb.Sheets[sheetName];
            const jsonData: string[][] = xlsxUtils.sheet_to_json(ws, {
              header: 1,
              defval: "",
              raw: false,
            });

            if (jsonData.length < 2) {
              setError(t("import.needHeaderAndData"));
              return;
            }

            const headers = jsonData[0].map((h) => String(h).trim());
            const rows = jsonData.slice(1).filter((r) => r.some((c) => String(c).trim()));

            const parsed: ParsedData = { headers, rows: rows.map((r) => r.map((c) => String(c))), sheetName };
            setParsedData(parsed);

            const autoMap = autoMatchColumns(headers);
            setMapping(autoMap);
            setStep("mapping");
          } catch {
            setError(t("import.parseFailed"));
          }
        };
        reader.readAsArrayBuffer(file);
      } else {
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const text = ev.target?.result as string;
            const lines = text.trim().split("\n");
            if (lines.length < 2) {
              setError(t("import.needHeaderAndData"));
              return;
            }

            let delimiter = ",";
            if (lines[0].includes(";") && !lines[0].includes(",")) {
              delimiter = ";";
            } else if (lines[0].includes("\t") && !lines[0].includes(",")) {
              delimiter = "\t";
            }

            const headers = parseCsvLine(lines[0], delimiter);
            const rows = lines
              .slice(1)
              .filter((l) => l.trim())
              .map((line) => parseCsvLine(line, delimiter));

            const parsed: ParsedData = { headers, rows };
            setParsedData(parsed);

            const autoMap = autoMatchColumns(headers);
            setMapping(autoMap);
            setStep("mapping");
          } catch {
            setError(t("import.parseFailed"));
          }
        };
        reader.readAsText(file);
      }
    },
    [t, autoMatchColumns],
  );

  const updateMapping = useCallback((systemField: string, fileColumn: string | null) => {
    setMapping((prev) => ({
      ...prev,
      [systemField]: fileColumn === "__none__" ? null : fileColumn,
    }));
  }, []);

  const matchedCount = useMemo(
    () => Object.values(mapping).filter(Boolean).length,
    [mapping],
  );

  const requiredMapped = useMemo(
    () => SYSTEM_FIELDS.filter((f) => f.required).every((f) => mapping[f.key]),
    [mapping],
  );

  const handleApplyMapping = useCallback(() => {
    if (!parsedData) return;

    const errors: string[] = [];
    const rows: MappedRow[] = [];

    const getColIdx = (systemField: string): number => {
      const colName = mapping[systemField];
      if (!colName) return -1;
      return parsedData.headers.indexOf(colName);
    };

    const addrIdx = getColIdx("address");
    const latIdx = getColIdx("latitude");
    const lngIdx = getColIdx("longitude");
    const notesIdx = getColIdx("notes");
    const twsIdx = getColIdx("timeWindowStart");
    const tweIdx = getColIdx("timeWindowEnd");
    const sdIdx = getColIdx("serviceDurationMin");
    const wIdx = getColIdx("weightKg");
    const vIdx = getColIdx("volumeM3");

    for (let i = 0; i < parsedData.rows.length; i++) {
      const row = parsedData.rows[i];
      const address = addrIdx >= 0 ? row[addrIdx]?.trim() : "";
      const latStr = latIdx >= 0 ? row[latIdx]?.trim() : "";
      const lngStr = lngIdx >= 0 ? row[lngIdx]?.trim() : "";

      const lat = parseFloat(latStr?.replace(",", "."));
      const lng = parseFloat(lngStr?.replace(",", "."));

      if (!address) {
        errors.push(t("import.rowMissingAddress", { row: i + 2 }));
        continue;
      }
      if (isNaN(lat) || isNaN(lng)) {
        errors.push(t("import.rowInvalidCoords", { row: i + 2 }));
        continue;
      }

      const mapped: MappedRow = { address, latitude: lat, longitude: lng };

      if (notesIdx >= 0 && row[notesIdx]?.trim()) {
        mapped.notes = row[notesIdx].trim();
      }
      if (twsIdx >= 0 && row[twsIdx]?.trim()) {
        mapped.timeWindowStart = row[twsIdx].trim();
      }
      if (tweIdx >= 0 && row[tweIdx]?.trim()) {
        mapped.timeWindowEnd = row[tweIdx].trim();
      }
      if (sdIdx >= 0 && row[sdIdx]?.trim()) {
        const dur = parseInt(row[sdIdx]);
        if (!isNaN(dur)) mapped.serviceDurationMin = dur;
      }
      if (wIdx >= 0 && row[wIdx]?.trim()) {
        const w = parseFloat(row[wIdx].replace(",", "."));
        if (!isNaN(w)) mapped.weightKg = w;
      }
      if (vIdx >= 0 && row[vIdx]?.trim()) {
        const v = parseFloat(row[vIdx].replace(",", "."));
        if (!isNaN(v)) mapped.volumeM3 = v;
      }

      rows.push(mapped);
    }

    setValidationErrors(errors);
    setMappedRows(rows);
    setStep("preview");
  }, [parsedData, mapping, t]);

  const handleImport = useCallback(() => {
    importMutation.mutate(
      { data: { organizationId: ORG_ID, stops: mappedRows } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
          reset();
          onSuccess();
          onOpenChange(false);
        },
        onError: () => setError(t("import.importFailed")),
      },
    );
  }, [mappedRows, importMutation, queryClient, reset, onSuccess, onOpenChange, t]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-primary" />
            {t("import.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 mb-4">
          {(["upload", "mapping", "preview"] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              <div
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors",
                  step === s
                    ? "bg-primary text-primary-foreground"
                    : (["upload", "mapping", "preview"].indexOf(step) > i
                        ? "bg-primary/20 text-primary"
                        : "bg-muted text-muted-foreground"),
                )}
              >
                <span className="w-4 h-4 rounded-full bg-current/20 flex items-center justify-center text-[10px]">
                  {["upload", "mapping", "preview"].indexOf(step) > i ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    i + 1
                  )}
                </span>
                {t(`import.step.${s}`)}
              </div>
            </div>
          ))}
        </div>

        <div className="flex-1 overflow-auto">
          {step === "upload" && (
            <UploadStep
              error={error}
              fileName={fileName}
              onFileChange={handleFileChange}
            />
          )}

          {step === "mapping" && parsedData && (
            <MappingStep
              headers={parsedData.headers}
              sampleRows={parsedData.rows.slice(0, 3)}
              mapping={mapping}
              onUpdateMapping={updateMapping}
              matchedCount={matchedCount}
              requiredMapped={requiredMapped}
              onBack={() => setStep("upload")}
              onNext={handleApplyMapping}
            />
          )}

          {step === "preview" && (
            <PreviewStep
              mappedRows={mappedRows}
              validationErrors={validationErrors}
              error={error}
              isPending={importMutation.isPending}
              onBack={() => setStep("mapping")}
              onImport={handleImport}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UploadStep({
  error,
  fileName,
  onFileChange,
}: {
  error: string | null;
  fileName: string;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="border-2 border-dashed border-border rounded-xl p-8 text-center hover:border-primary/50 transition-colors">
        <Upload className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
        <p className="font-medium mb-1">{t("import.dragOrClick")}</p>
        <p className="text-xs text-muted-foreground mb-4">{t("import.supportedFormats")}</p>
        <Label className="cursor-pointer">
          <Input
            type="file"
            accept=".csv,.xlsx,.xls,.xlsb"
            onChange={onFileChange}
            className="hidden"
          />
          <span className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer">
            <FileSpreadsheet className="h-4 w-4" />
            {t("import.selectFile")}
          </span>
        </Label>
        {fileName && (
          <p className="mt-3 text-sm text-muted-foreground">{fileName}</p>
        )}
      </div>
      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}

function MappingStep({
  headers,
  sampleRows,
  mapping,
  onUpdateMapping,
  matchedCount,
  requiredMapped,
  onBack,
  onNext,
}: {
  headers: string[];
  sampleRows: string[][];
  mapping: ColumnMapping;
  onUpdateMapping: (systemField: string, fileColumn: string | null) => void;
  matchedCount: number;
  requiredMapped: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">{t("import.matchColumns")}</p>
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
              <th className="p-2.5 text-left text-xs font-semibold text-muted-foreground w-[45%]">
                {t("import.systemField")}
              </th>
              <th className="p-2.5 text-center w-[10%]">
                <ArrowRight className="h-4 w-4 mx-auto text-muted-foreground" />
              </th>
              <th className="p-2.5 text-left text-xs font-semibold text-muted-foreground w-[45%]">
                {t("import.fileColumn")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {SYSTEM_FIELDS.map((field) => {
              const mapped = mapping[field.key];
              const colIdx = mapped ? headers.indexOf(mapped) : -1;
              const sampleValue = colIdx >= 0 && sampleRows[0] ? sampleRows[0][colIdx] : null;

              return (
                <tr
                  key={field.key}
                  className={cn(
                    "transition-colors",
                    mapped ? "bg-primary/5" : (field.required ? "bg-destructive/5" : ""),
                  )}
                >
                  <td className="p-2.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "w-2 h-2 rounded-full shrink-0",
                          field.required ? "bg-destructive" : "bg-muted-foreground",
                        )}
                      />
                      <span className="font-medium text-xs">{t(field.labelKey)}</span>
                      {mapped && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                    </div>
                  </td>
                  <td className="p-2.5 text-center">
                    <ArrowRight className={cn("h-3.5 w-3.5 mx-auto", mapped ? "text-primary" : "text-muted-foreground/30")} />
                  </td>
                  <td className="p-2.5">
                    <Select
                      value={mapped || "__none__"}
                      onValueChange={(val) => onUpdateMapping(field.key, val)}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder={t("import.selectColumn")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">
                          <span className="text-muted-foreground">— {t("import.skip")} —</span>
                        </SelectItem>
                        {headers.map((h) => (
                          <SelectItem key={h} value={h}>
                            {h}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {sampleValue && (
                      <p className="text-[10px] text-muted-foreground mt-1 truncate">
                        {t("import.example")}: {sampleValue}
                      </p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex justify-between pt-2">
        <Button variant="outline" size="sm" onClick={onBack} className="gap-1">
          <ChevronLeft className="h-4 w-4" /> {t("common.back")}
        </Button>
        <Button
          size="sm"
          onClick={onNext}
          disabled={!requiredMapped}
          className="gap-1"
        >
          {t("import.preview")} <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function PreviewStep({
  mappedRows,
  validationErrors,
  error,
  isPending,
  onBack,
  onImport,
}: {
  mappedRows: MappedRow[];
  validationErrors: string[];
  error: string | null;
  isPending: boolean;
  onBack: () => void;
  onImport: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      {validationErrors.length > 0 && (
        <div className="p-3 rounded-lg bg-amber-500/10 text-amber-500 text-xs space-y-1 max-h-24 overflow-auto">
          <p className="font-semibold flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5" />
            {t("import.skippedRows", { count: validationErrors.length })}
          </p>
          {validationErrors.slice(0, 5).map((e, i) => (
            <p key={i}>{e}</p>
          ))}
          {validationErrors.length > 5 && (
            <p className="text-muted-foreground">
              {t("common.andMore", { count: validationErrors.length - 5 })}
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {mappedRows.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            {t("import.readyToImport", { count: mappedRows.length })}
          </p>
          <div className="max-h-56 overflow-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="p-2 text-left">#</th>
                  <th className="p-2 text-left">{t("import.field.address")}</th>
                  <th className="p-2 text-left">{t("import.field.latitude")}</th>
                  <th className="p-2 text-left">{t("import.field.longitude")}</th>
                  <th className="p-2 text-left">{t("import.field.notes")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {mappedRows.slice(0, 25).map((row, i) => (
                  <tr key={i} className="hover:bg-muted/30">
                    <td className="p-2 text-muted-foreground">{i + 1}</td>
                    <td className="p-2 truncate max-w-[180px]">{row.address}</td>
                    <td className="p-2">{row.latitude.toFixed(4)}</td>
                    <td className="p-2">{row.longitude.toFixed(4)}</td>
                    <td className="p-2 truncate max-w-[120px] text-muted-foreground">
                      {row.notes || "—"}
                    </td>
                  </tr>
                ))}
                {mappedRows.length > 25 && (
                  <tr>
                    <td colSpan={5} className="p-2 text-center text-muted-foreground">
                      {t("common.andMore", { count: mappedRows.length - 25 })}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex justify-between pt-2">
        <Button variant="outline" size="sm" onClick={onBack} className="gap-1">
          <ChevronLeft className="h-4 w-4" /> {t("import.backToMapping")}
        </Button>
        <Button
          size="sm"
          onClick={onImport}
          disabled={mappedRows.length === 0 || isPending}
          className="gap-2 bg-primary text-primary-foreground"
        >
          <Upload className="h-4 w-4" />
          {isPending
            ? t("import.importing")
            : t("import.importCount", { count: mappedRows.length })}
        </Button>
      </div>
    </div>
  );
}
