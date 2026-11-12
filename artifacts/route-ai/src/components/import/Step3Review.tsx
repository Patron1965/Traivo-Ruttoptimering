import { ImportInfoSection } from "./ImportInfoDisclosure";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2, AlertTriangle, CheckCircle2, Download } from "lucide-react";
import type { MappedRow, RejectedImportRow } from "./types";
import { cn } from "@/lib/utils";
import { useImportInfo } from "./ImportInfoDisclosure";
import { DualHorizontalScroll } from "@/components/ui/dual-horizontal-scroll";
import {
  filterMappedRows,
  getImportRowStatus,
  reconcileImportReviewCounts,
  updateMappedRowById,
  uniqueRejectedRows,
  validateMappedRow as validateRow,
  type ImportReviewFilter,
} from "./import-review";
import { getImportReviewCopy } from "./import-review-copy";

export { validateMappedRow } from "./import-review";

interface Props {
  rows: MappedRow[];
  onUpdateRow: (id: string, updates: Partial<MappedRow>) => void;
  onDeleteRow: (id: string) => void;
  onNext: () => void;
  onBack: () => void;
  rejectedRows: RejectedImportRow[];
}

function exportRejected(
  rows: RejectedImportRow[],
  labels: { sourceRow: string; reason: string; originalValues: string },
) {
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csv = [
    [labels.sourceRow, labels.reason, labels.originalValues].map(escape).join(";"),
    ...rows.map((row) => [
      row.sourceRowNumber,
      row.reasons.join(" "),
      row.values.join(" | "),
    ].map(escape).join(";")),
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "avvisade-import-rader.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function Step3Review({ rows, onUpdateRow, onDeleteRow, onNext, onBack, rejectedRows }: Props) {
  const { i18n, t } = useTranslation();
  const importInfo = useImportInfo();
  const copy = getImportReviewCopy(i18n.language);
  const [filter, setFilter] = useState<ImportReviewFilter>("problems");

  const hasBlockingErrors = useMemo(() => {
    return rows.some((r) => validateRow(r, copy.validation).length > 0);
  }, [copy.validation, rows]);
  const counts = useMemo(
    () => reconcileImportReviewCounts(rows, rejectedRows, {
      validationMessages: copy.validation,
    }),
    [copy.validation, rejectedRows, rows],
  );
  const visibleRows = useMemo(
    () => filterMappedRows(rows, filter, { validationMessages: copy.validation }),
    [copy.validation, filter, rows],
  );
  const problemRows = useMemo(
    () => filterMappedRows(rows, "problems", { validationMessages: copy.validation }),
    [copy.validation, rows],
  );
  const uniqueRejected = useMemo(() => uniqueRejectedRows(rejectedRows), [rejectedRows]);

  const handleNext = () => {
    // Keep the gate in the event handler as well as on the button. This
    // protects callers that trigger the action from a keyboard or test
    // harness while React is between renders.
    if (hasBlockingErrors || rows.length === 0) return;
    onNext();
  };

  const handleUpdateRow = (id: string, updates: Partial<MappedRow>) => {
    const current = rows.find((row) => row._id === id);
    if (filter === "problems" && current) {
      const corrected = updateMappedRowById([current], id, updates)[0];
      // A corrected row would otherwise disappear from the default problems
      // view while its input is still focused. Keep the edit target mounted by
      // moving to All once it passes validation; the stable _id also keeps
      // focus through ordinary rerenders.
      if (getImportRowStatus(corrected, { validationMessages: copy.validation }) === "ready") {
        setFilter("all");
      }
    }
    onUpdateRow(id, updates);
  };

  const filterOptions: Array<{
    value: ImportReviewFilter;
    label: string;
    count: number;
    description: string;
  }> = [
    {
      value: "problems",
      label: copy.filters.problems,
      count: counts.action,
      description: copy.review.problemsDescription,
    },
    {
      value: "all",
      label: copy.filters.all,
      count: counts.mapped,
      description: copy.review.allDescription,
    },
    {
      value: "ready",
      label: copy.filters.ready,
      count: counts.ready,
      description: copy.review.readyDescription,
    },
    {
      value: "rejected",
      label: copy.filters.rejected,
      count: counts.rejected,
      description: copy.review.rejectedFilterDescription,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t("wizard.step3")}</h2>
          {(!importInfo.inImportFlow || importInfo.visible.help) && <p className="text-muted-foreground text-sm">
            {t("import.step3Desc")}
          </p>}
        </div>
      </div>

      <div className="space-y-2" data-testid="import-review-filters">
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label={copy.review.filterLabel}>
          {filterOptions.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={filter === option.value ? "default" : "outline"}
              size="sm"
              role="tab"
              aria-selected={filter === option.value}
              data-testid={`import-review-filter-${option.value}`}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
              <span className="ml-1.5 text-xs opacity-80">({option.count})</span>
            </Button>
          ))}
        </div>
        <ImportInfoSection category="help" title="Om filtret">
          <p className="text-xs text-muted-foreground">
            {filterOptions.find((option) => option.value === filter)?.description}
          </p>
        </ImportInfoSection>
      </div>

      <div className="border rounded-xl overflow-hidden bg-card">
        <DualHorizontalScroll label={t("common.horizontalScroll")} contentProps={{ className: "md:max-h-[60dvh] md:overflow-y-auto md:overscroll-contain" }}>
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground md:sticky md:top-0 md:z-10">
              <tr>
                <th className="px-4 py-3 text-left font-medium w-8">Status</th>
                <th className="px-4 py-3 text-left font-medium min-w-[130px]">{t("importPage.field.date")} *</th>
                <th className="px-4 py-3 text-left font-medium min-w-[200px]">{t("import.field.address")} *</th>
                <th className="px-4 py-3 text-left font-medium min-w-[150px]">{t("import.field.pickupAddress")}</th>
                <th className="px-4 py-3 text-left font-medium min-w-[150px]">{t("importPage.field.contactName")}</th>
                <th className="px-4 py-3 text-left font-medium min-w-[150px]">{t("importPage.field.contactPhone")}</th>
                <th className="px-4 py-3 text-left font-medium min-w-[100px]">{t("import.field.timeWindowStart")}</th>
                <th className="px-4 py-3 text-left font-medium min-w-[100px]">{t("import.field.timeWindowEnd")}</th>
                <th className="px-4 py-3 text-left font-medium w-24">{t("import.field.weightKg")}</th>
                <th className="px-4 py-3 text-left font-medium w-24">{t("import.field.volumeM3")}</th>
                <th className="px-4 py-3 text-center font-medium w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleRows.map((row) => {
                const errors = validateRow(row, copy.validation);
                const hasError = errors.length > 0;

                return (
                  <tr key={row._id} className={cn(hasError ? "bg-destructive/5" : "")}>
                    <td className="px-4 py-2" title={`Källrad ${row._sourceRowNumber}`}>
                      {hasError ? (
                        <div title={errors.join(", ")}>
                          <AlertTriangle className="w-4 h-4 text-destructive" />
                        </div>
                      ) : (
                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        type="date"
                        value={row.date || ""}
                        onChange={(e) => handleUpdateRow(row._id, { date: e.target.value })}
                        className={cn("h-8", !row.date && "border-destructive")}
                        data-testid={`import-review-date-${row._id}`}
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        value={row.address || ""}
                        onChange={(e) => handleUpdateRow(row._id, {
                          address: e.target.value,
                          latitude: undefined,
                          longitude: undefined,
                          _deliveryGeocodeError: undefined,
                          _deliveryCandidates: undefined,
                        })}
                        className={cn("h-8", !row.address && "border-destructive")}
                        data-testid={`import-review-address-${row._id}`}
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        value={row.pickupAddress || ""}
                        onChange={(e) => handleUpdateRow(row._id, {
                          pickupAddress: e.target.value,
                          pickupLatitude: undefined,
                          pickupLongitude: undefined,
                          _pickupGeocodeError: undefined,
                          _pickupCandidates: undefined,
                        })}
                        className="h-8"
                        data-testid={`import-review-pickup-address-${row._id}`}
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        value={row.contactName || ""}
                        onChange={(e) => handleUpdateRow(row._id, { contactName: e.target.value })}
                        className="h-8"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        value={row.contactPhone || ""}
                        onChange={(e) => handleUpdateRow(row._id, { contactPhone: e.target.value })}
                        className="h-8"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        type="time"
                        value={row.timeWindowStart || ""}
                        onChange={(e) => handleUpdateRow(row._id, { timeWindowStart: e.target.value })}
                        className="h-8"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        type="time"
                        value={row.timeWindowEnd || ""}
                        onChange={(e) => handleUpdateRow(row._id, { timeWindowEnd: e.target.value })}
                        className="h-8"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        type="number"
                        value={row.weightKg ?? ""}
                        onChange={(e) => handleUpdateRow(row._id, { weightKg: parseFloat(e.target.value) || undefined })}
                        className="h-8"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        type="number"
                        value={row.volumeM3 ?? ""}
                        onChange={(e) => handleUpdateRow(row._id, { volumeM3: parseFloat(e.target.value) || undefined })}
                        className="h-8"
                      />
                    </td>
                    <td className="px-4 py-2 text-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => onDeleteRow(row._id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-muted-foreground">
                    {copy.review.noRows}
                  </td>
                </tr>
              )}
              {rows.length > 0 && visibleRows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-muted-foreground">
                    {filter === "rejected" ? copy.review.noRejectedRows : copy.review.noProblems}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </DualHorizontalScroll>
      </div>

      {(filter === "rejected" || uniqueRejected.length > 0 || hasBlockingErrors) && (
        <div className="rounded-xl border border-amber-300 bg-amber-50/50 p-4 dark:bg-amber-950/10">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-medium">{copy.review.rejectedHeading}</h3>
              <p className="text-sm text-muted-foreground">{copy.review.rejectedDescription}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              data-testid="export-rejected-import-rows"
              onClick={() => exportRejected(uniqueRejectedRows([
                ...uniqueRejected,
                ...problemRows.flatMap((row) => {
                  const reasons = validateRow(row, copy.validation);
                  return reasons.length ? [{
                    sourceRowNumber: row._sourceRowNumber,
                    values: row._sourceValues,
                    reasons,
                  }] : [];
                }),
              ]), {
                sourceRow: copy.review.sourceRow,
                reason: copy.review.exportReason,
                originalValues: copy.review.exportOriginalValues,
              })}
            >
              <Download className="mr-2 h-4 w-4" /> {copy.review.exportAction}
            </Button>
          </div>
          <DualHorizontalScroll
            label={t("common.horizontalScroll")}
            contentProps={{ className: "mt-3 max-h-40 overflow-y-auto" }}
          >
            <ul className="space-y-1 text-sm">
              {uniqueRejected.map((row) => (
                <li key={`${row.sourceRowNumber}-${row.reasons.join()}`}>
                  <strong>{copy.review.sourceRow} {row.sourceRowNumber}:</strong> {row.reasons.join(" ")}
                </li>
              ))}
              {filter === "rejected" && uniqueRejected.length === 0 && (
                <li className="text-muted-foreground">{copy.review.noRejectedRows}</li>
              )}
              {filter !== "rejected" && problemRows.map((row) => {
                const reasons = validateRow(row, copy.validation);
                return reasons.length ? <li key={row._id}><strong>{copy.review.sourceRow} {row._sourceRowNumber}:</strong> {reasons.join(" ")}</li> : null;
              })}
            </ul>
          </DualHorizontalScroll>
        </div>
      )}

      <div className="sticky bottom-0 z-20 -mx-1 border-t bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 flex justify-between items-center" data-testid="import-review-actions">
        <Button variant="outline" onClick={onBack}>
          {t("common.back")}
        </Button>
        <Button onClick={handleNext} disabled={hasBlockingErrors || rows.length === 0}>
          {t("wizard.next")}
        </Button>
      </div>
    </div>
  );
}
