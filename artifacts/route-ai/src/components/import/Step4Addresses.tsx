import { ImportInfoSection } from "./ImportInfoDisclosure";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Stop } from "@workspace/api-client-react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { isValidCoordinate } from "@/lib/map-utils";
import { composeDeliveryAddress } from "@/lib/delivery-address";
import { localizeError, TrustedLocalizedError } from "@/lib/localize-error";
import { GeocodingReviewMap } from "./GeocodingReviewMap";
import type { GeocodeCandidate, GeocodeResult, MappedRow, RejectedImportRow } from "./types";
import {
  filterMappedRows,
  getImportRowStatus,
  isMappedRowAddressReady,
  reconcileImportReviewCounts,
  uniqueRejectedRows,
  validateMappedRow,
  type ImportReviewFilter,
} from "./import-review";
import { getImportReviewCopy } from "./import-review-copy";

interface Step4AddressesProps {
  organizationId: string;
  rows: MappedRow[];
  onRowsChange: (rows: MappedRow[]) => void;
  isSaving: boolean;
  onBack: () => void;
  onNext: () => void;
  /** Optional until the owning workflow wires the rejected-row projection. */
  rejectedRows?: RejectedImportRow[];
}

type AddressKind = "delivery" | "pickup";

interface GeocodeTarget {
  id: string;
  rowId: string;
  kind: AddressKind;
  address: string;
  postalCode?: string;
  city?: string;
}

interface BatchGeocodeResponseItem {
  id?: string;
  address?: string;
  query?: string;
  status: "matched" | "candidates" | "not_found" | "provider_unavailable" | "invalid_input";
  result?: GeocodeResult | null;
  candidates?: GeocodeCandidate[];
}

interface BatchGeocodeResponse {
  results: BatchGeocodeResponseItem[];
}

function getErrorMessage(
  status: string,
  candidateCount: number,
  t: (key: string) => string,
): string {
  switch (status) {
    case "not_found": return t("import.geocodeAddressNotFound");
    case "provider_unavailable": return t("import.geocodeProviderUnavailable");
    case "invalid_input": return t("import.geocodeInvalidInput");
    case "candidates": return candidateCount === 1
      ? t("import.geocodeOneCandidate")
      : t("import.geocodeMultipleCandidates");
    default: return t("import.geocodeUnknown");
  }
}

function targetFor(row: MappedRow, kind: AddressKind): GeocodeTarget | null {
  if (kind === "pickup") {
    const address = row.pickupAddress;
    if (!address?.trim()) return null;
    // Keep the exact edited value in the request identity. Even a whitespace
    // edit must not let a response from the previous value reintroduce a
    // candidate after the user cleared it.
    return { id: `${row._id}-pickup`, rowId: row._id, kind, address };
  }
  const address = row.address;
  if (!address?.trim()) return null;
  return {
    id: `${row._id}-delivery`,
    rowId: row._id,
    kind,
    address,
    postalCode: row.postalCode,
    city: row.city,
  };
}

export function needsGeocoding(row: MappedRow, kind: AddressKind): boolean {
  if (kind === "pickup") {
    return Boolean(row.pickupAddress?.trim())
      && !isValidCoordinate(row.pickupLatitude, row.pickupLongitude)
      && !row._pickupCandidates?.length;
  }
  return !isValidCoordinate(row.latitude, row.longitude)
    && !row._deliveryCandidates?.length;
}

export function rowIsReady(row: MappedRow): boolean {
  return validateMappedRow(row).length === 0 && isMappedRowAddressReady(row);
}

/**
 * Return the source file's delivery locality without replacing or composing
 * the editable street value. Pickup cards must not expose delivery locality
 * data, even when the source row contains it.
 */
export function getSourcePostalCity(
  row: Pick<MappedRow, "postalCode" | "city">,
  kind: AddressKind = "delivery",
): string | null {
  if (kind === "pickup") return null;

  const values = [row.postalCode, row.city]
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter((value) => value.length > 0);
  return values.length > 0 ? values.join(" ") : null;
}

function toMapStop(row: MappedRow, kind: AddressKind, organizationId: string): Stop | null {
  const latitude = kind === "pickup" ? row.pickupLatitude : row.latitude;
  const longitude = kind === "pickup" ? row.pickupLongitude : row.longitude;
  const address = kind === "pickup"
    ? row.pickupAddress
    : composeDeliveryAddress(row.address, row.postalCode, row.city, {
      composed: row._deliveryAddressComposed === true,
    });
  if (!address || !isValidCoordinate(latitude, longitude)) return null;

  return {
    id: `${row._id}-${kind}`,
    organizationId,
    routeId: null,
    customerId: null,
    address,
    latitude: latitude as number,
    longitude: longitude as number,
    timeWindowStart: null,
    timeWindowEnd: null,
    unavailablePeriods: [],
    serviceDurationMin: row.serviceDurationMin ?? 5,
    weightKg: row.weightKg ?? null,
    volumeM3: row.volumeM3 ?? null,
    status: "pending",
    jobType: (row.jobType as any) || "delivery",
    sequenceOrder: null,
    notes: kind === "pickup" ? "Pickup" : "Leverans",
    trackingCode: row.referenceNumber ?? null,
    contactName: row.contactName ?? null,
    contactEmail: row.contactEmail ?? null,
    contactPhone: row.contactPhone ?? null,
    externalRef: row.referenceNumber ?? null,
    shopifyOrderName: null,
    pickupAddress: null,
    pickupLatitude: null,
    pickupLongitude: null,
    createdAt: new Date().toISOString(),
  };
}

export function Step4Addresses({
  organizationId,
  rows,
  onRowsChange,
  isSaving,
  onBack,
  onNext,
  rejectedRows = [],
}: Step4AddressesProps) {
  const { i18n, t } = useTranslation();
  const copy = getImportReviewCopy(i18n.language);
  const [filter, setFilter] = useState<ImportReviewFilter>("problems");
  const [isGeocoding, setIsGeocoding] = useState(false);
  const [progress, setProgress] = useState(0);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [focusStopId, setFocusStopId] = useState<string | null>(null);
  const initialGeocodeStarted = useRef(false);
  const rowsRef = useRef(rows);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const inputRefs = useRef(new Map<string, HTMLInputElement>());
  const mapPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const commitRows = (update: (current: MappedRow[]) => MappedRow[]) => {
    const next = update(rowsRef.current);
    rowsRef.current = next;
    onRowsChange(next);
  };

  const counts = useMemo(
    () => reconcileImportReviewCounts(rows, rejectedRows, {
      addressesResolved: true,
      validationMessages: copy.validation,
    }),
    [copy.validation, rejectedRows, rows],
  );
  const visibleRows = useMemo(
    () => filterMappedRows(rows, filter, {
      addressesResolved: true,
      validationMessages: copy.validation,
    }),
    [copy.validation, filter, rows],
  );
  const uniqueRejected = useMemo(() => uniqueRejectedRows(rejectedRows), [rejectedRows]);
  const readyCount = counts.ready;
  const allReady = rows.length > 0 && counts.action === 0 && counts.ready === counts.mapped;

  const handleNext = () => {
    if (!allReady || isGeocoding || isSaving) return;
    onNext();
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

  const mapStops = useMemo(
    () =>
      rows.flatMap((row) =>
        ([toMapStop(row, "pickup", organizationId), toMapStop(row, "delivery", organizationId)])
          .filter((stop): stop is Stop => stop !== null),
      ),
    [organizationId, rows],
  );
  const rowNumberById = useMemo(
    () => new Map(rows.map((row, index) => [row._id, index + 1])),
    [rows],
  );
  const mapStopTargets = useMemo(() => {
    const targets = new Map<string, { rowId: string; kind: AddressKind }>();
    for (const row of rows) {
      if (isValidCoordinate(row.pickupLatitude, row.pickupLongitude)) {
        targets.set(`${row._id}-pickup`, { rowId: row._id, kind: "pickup" });
      }
      if (isValidCoordinate(row.latitude, row.longitude)) {
        targets.set(`${row._id}-delivery`, { rowId: row._id, kind: "delivery" });
      }
    }
    return targets;
  }, [rows]);
  const stopMarkerLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const row of rows) {
      const number = rowNumberById.get(row._id);
      if (!number) continue;
      if (isValidCoordinate(row.pickupLatitude, row.pickupLongitude)) {
        labels[`${row._id}-pickup`] = `${number}H`;
      }
      if (isValidCoordinate(row.latitude, row.longitude)) {
        labels[`${row._id}-delivery`] = `${number}L`;
      }
    }
    return labels;
  }, [rowNumberById, rows]);
  const mappedPickupCount = useMemo(
    () => rows.filter((row) => Boolean(row.pickupAddress?.trim())
      && isValidCoordinate(row.pickupLatitude, row.pickupLongitude)).length,
    [rows],
  );
  const mappedDeliveryCount = useMemo(
    () => rows.filter((row) => isValidCoordinate(row.latitude, row.longitude)).length,
    [rows],
  );

  const scrollToRow = (rowId: string) => {
    requestAnimationFrame(() => {
      const rowElement = rowRefs.current.get(rowId);
      const panel = rowElement?.parentElement?.parentElement;
      if (rowElement && panel) {
        panel.scrollTo({
          top: panel.scrollTop + rowElement.getBoundingClientRect().top
            - panel.getBoundingClientRect().top - panel.clientHeight / 3,
          behavior: "smooth",
        });
      }
    });
  };

  const focusAddressInput = (rowId: string, kind: AddressKind) => {
    setFilter("all");
    window.setTimeout(() => {
      const input = inputRefs.current.get(`${rowId}-${kind}`);
      input?.scrollIntoView({ behavior: "smooth", block: "center" });
      input?.focus();
    }, 0);
  };

  const selectMapStop = (stopId: string) => {
    const target = mapStopTargets.get(stopId);
    setSelectedStopId(stopId);
    setFocusStopId(null);
    if (target && !visibleRows.some((row) => row._id === target.rowId)) {
      setFilter("all");
    }
    if (target) scrollToRow(target.rowId);
  };

  const selectRowStop = (stopId: string) => {
    setSelectedStopId(stopId);
    setFocusStopId(null);
    requestAnimationFrame(() => {
      setFocusStopId(stopId);
      mapPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const geocodeTargets = async (targets: GeocodeTarget[]) => {
    if (targets.length === 0) return;

    setIsGeocoding(true);
    setProgress(0);
    setRequestError(null);
    let completed = 0;
    try {
      // Keep each request small enough for the rate-limited fallback provider.
      const batchSize = 5;
      for (let index = 0; index < targets.length; index += batchSize) {
        const chunk = targets.slice(index, index + batchSize);
        const response = await fetch(`${import.meta.env.BASE_URL}api/geocode/batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            addresses: chunk.map((target) => ({
              id: target.id,
              address: target.address,
              postalCode: target.postalCode,
              city: target.city,
            })),
            country: "se",
          }),
        });
        if (!response.ok) {
          const message = response.status === 401
            ? t("import.geocodeUnauthorized")
            : response.status === 403
              ? t("import.geocodeForbidden")
              : response.status === 429
                ? t("import.geocodeRateLimited")
                : [502, 503, 504].includes(response.status)
                  ? t("import.geocodeUnavailable")
                  : t("import.geocodeRequestFailed", { status: response.status });
          throw new TrustedLocalizedError(message);
        }

        const payload = (await response.json()) as BatchGeocodeResponse;
        const resultsById = new Map<string, BatchGeocodeResponseItem>();
        for (const item of payload.results ?? []) {
          if (item.id) resultsById.set(item.id, item);
        }

        commitRows((currentRows) => currentRows.map((row) => {
          const targetIndexes = chunk.filter((t) => t.rowId === row._id);
          if (targetIndexes.length === 0) return row;

          const next = { ...row };
          for (const target of targetIndexes) {
            const item = resultsById.get(target.id);
            if (!item) continue;
            const currentTarget = targetFor(row, target.kind);
            const requestStillCurrent = currentTarget
              && currentTarget.address === target.address
              && currentTarget.postalCode === target.postalCode
              && currentTarget.city === target.city;
            if (!requestStillCurrent) continue;

            if (target.kind === "pickup") {
              if (item.status === "matched" && item.result && isValidCoordinate(item.result.latitude, item.result.longitude)) {
                next.pickupLatitude = item.result.latitude;
                next.pickupLongitude = item.result.longitude;
                next._pickupGeocodeError = undefined;
                next._pickupCandidates = undefined;
              } else if (item.status === "candidates" && item.candidates?.length) {
                next.pickupLatitude = undefined;
                next.pickupLongitude = undefined;
                next._pickupGeocodeError = undefined;
                next._pickupCandidates = item.candidates.slice(0, 5);
              } else {
                next.pickupLatitude = undefined;
                next.pickupLongitude = undefined;
                next._pickupCandidates = undefined;
                  next._pickupGeocodeError = getErrorMessage(item.status, item.candidates?.length ?? 0, t);
              }
            } else {
              if (item.status === "matched" && item.result && isValidCoordinate(item.result.latitude, item.result.longitude)) {
                next.latitude = item.result.latitude;
                next.longitude = item.result.longitude;
                next._deliveryGeocodeError = undefined;
                next._deliveryCandidates = undefined;
              } else if (item.status === "candidates" && item.candidates?.length) {
                next.latitude = undefined;
                next.longitude = undefined;
                next._deliveryGeocodeError = undefined;
                next._deliveryCandidates = item.candidates.slice(0, 5);
              } else {
                next.latitude = undefined;
                next.longitude = undefined;
                next._deliveryCandidates = undefined;
                  next._deliveryGeocodeError = getErrorMessage(item.status, item.candidates?.length ?? 0, t);
              }
            }
          }
          return next;
        }));
        completed += chunk.length;
        setProgress(Math.round((completed / targets.length) * 100));
      }
    } catch (error) {
      setRequestError(localizeError(error, t, { fallbackKey: "common.errorRequestFailed" }));
    } finally {
      setIsGeocoding(false);
    }
  };

  useEffect(() => {
    if (initialGeocodeStarted.current || rows.length === 0) return;
    initialGeocodeStarted.current = true;
    const targets = rows.flatMap((row) =>
      (["pickup", "delivery"] as const)
        .filter((kind) => needsGeocoding(row, kind))
        .map((kind) => targetFor(row, kind))
        .filter((target): target is GeocodeTarget => target !== null),
    );
    void geocodeTargets(targets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  const updateAddress = (rowId: string, kind: AddressKind, value: string) => {
    commitRows((currentRows) => currentRows.map((row) => {
      if (row._id !== rowId) return row;
      if (kind === "pickup") {
        return {
          ...row,
          pickupAddress: value,
          pickupLatitude: undefined,
          pickupLongitude: undefined,
          _pickupGeocodeError: undefined,
          _pickupCandidates: undefined,
        };
      }
      return {
        ...row,
        // Keep the composed mapping marker: this input edits the street part
        // of the delivery target, while the mapped postcode/locality remain
        // structured components and are still joined for geocoding/persist.
        address: value,
        latitude: undefined,
        longitude: undefined,
        _deliveryGeocodeError: undefined,
        _deliveryCandidates: undefined,
      };
    }));
  };

  const retryRow = (row: MappedRow) => {
    const targets = (["pickup", "delivery"] as const)
      .filter((kind) => {
        if (kind === "pickup") return Boolean(row.pickupAddress?.trim()) && !isValidCoordinate(row.pickupLatitude, row.pickupLongitude);
        return !isValidCoordinate(row.latitude, row.longitude);
      })
      .map((kind) => targetFor(row, kind))
      .filter((target): target is GeocodeTarget => target !== null);
    void geocodeTargets(targets);
  };

  const lookupAddress = (row: MappedRow, kind: AddressKind) => {
    if (isGeocoding) return;
    const target = targetFor(row, kind);
    if (target) void geocodeTargets([target]);
  };

  const retryAll = () => {
    const targets = rows.flatMap((row) =>
      (["pickup", "delivery"] as const)
        .filter((kind) => needsGeocoding(row, kind))
        .map((kind) => targetFor(row, kind))
        .filter((target): target is GeocodeTarget => target !== null),
    );
    void geocodeTargets(targets);
  };

  const candidateAddressCount = rows.reduce((count, row) => {
    const deliveryCandidates = row._deliveryCandidates?.length ? 1 : 0;
    const pickupCandidates = row._pickupCandidates?.length ? 1 : 0;
    return count + deliveryCandidates + pickupCandidates;
  }, 0);

  const selectCandidate = (rowId: string, kind: AddressKind, candidate: GeocodeCandidate) => {
    commitRows((currentRows) => currentRows.map((row) => {
      if (row._id !== rowId) return row;
      if (kind === "pickup") {
        return {
          ...row,
          pickupLatitude: candidate.latitude,
          pickupLongitude: candidate.longitude,
          _pickupGeocodeError: undefined,
          _pickupCandidates: undefined,
        };
      }
      return {
        ...row,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        _deliveryGeocodeError: undefined,
        _deliveryCandidates: undefined,
      };
    }));
  };

  const selectAllCandidates = () => {
    if (isGeocoding || candidateAddressCount === 0) return;

    commitRows((currentRows) => currentRows.map((row) => {
      const deliveryCandidate = row._deliveryCandidates?.[0];
      const pickupCandidate = row._pickupCandidates?.[0];
      if (!deliveryCandidate && !pickupCandidate) return row;

      return {
        ...row,
        ...(deliveryCandidate
          ? {
              latitude: deliveryCandidate.latitude,
              longitude: deliveryCandidate.longitude,
              _deliveryGeocodeError: undefined,
              _deliveryCandidates: undefined,
            }
          : {}),
        ...(pickupCandidate
          ? {
              pickupLatitude: pickupCandidate.latitude,
              pickupLongitude: pickupCandidate.longitude,
              _pickupGeocodeError: undefined,
              _pickupCandidates: undefined,
            }
          : {}),
      };
    }));
  };

  const renderCandidates = (row: MappedRow, kind: AddressKind) => {
    const candidates = kind === "pickup" ? row._pickupCandidates : row._deliveryCandidates;
    if (!candidates || candidates.length === 0) return null;

    return (
      <div className="mt-2 space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          {candidates.length === 1
            ? t("import.geocodeOneCandidatePrompt")
            : t("import.geocodeMultipleCandidatesPrompt")}
        </p>
        {kind === "delivery" && (
          <p className="text-xs text-muted-foreground">
            {t("import.partialMatchHelp")}
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          {candidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => selectCandidate(row._id, kind, candidate)}
              data-testid={`planning-draft-geocode-candidate-${candidate.id}`}
              className="flex w-full min-h-[44px] items-center justify-between gap-3 rounded-md border bg-card p-3 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                <span className="line-clamp-2 font-medium">{candidate.displayName}</span>
                <span className="text-[10px] uppercase text-muted-foreground shrink-0">
                  {candidate.source === "google" ? t("import.googleMaps") : t("import.openStreetMap")}
                  {candidate.partial ? ` · ${t("import.partialMatch")}` : ""}
                </span>
              </div>
              <Badge variant="secondary" className="shrink-0 font-medium">{t("import.selectAddress")}</Badge>
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("import.reviewAddressesTitle")}</h2>
          <ImportInfoSection category="help" title="Hjälptext" className="mt-1">
            <p className="text-sm text-muted-foreground">
              {t("import.reviewAddressesDescription")}
            </p>
          </ImportInfoSection>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {candidateAddressCount > 0 && (
            <Button
              type="button"
              size="sm"
              onClick={selectAllCandidates}
              disabled={isGeocoding}
              title={t("import.selectFirstSuggestion")}
            >
              <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
              {t("import.selectAll")}
              <span className="ml-1 text-xs opacity-80">({candidateAddressCount})</span>
            </Button>
          )}
          <Badge variant={allReady ? "default" : "secondary"}>
            {t("import.readyAddressesCount", { ready: readyCount, total: counts.mapped })}
          </Badge>
          {counts.awaitingAddress > 0 && (
            <Badge variant="secondary" data-testid="import-address-awaiting-count">
              {counts.awaitingAddress} {copy.count.awaitingAddress}
            </Badge>
          )}
        </div>
      </div>

      <div className="space-y-2" data-testid="import-address-filters">
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label={copy.review.filterLabel}>
          {filterOptions.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={filter === option.value ? "default" : "outline"}
              size="sm"
              role="tab"
              aria-selected={filter === option.value}
              data-testid={`import-address-filter-${option.value}`}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
              <span className="ml-1.5 text-xs opacity-80">({option.count})</span>
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {filterOptions.find((option) => option.value === filter)?.description}
        </p>
      </div>

      {isGeocoding && (
        <Card className="space-y-2 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {t("import.geocodingAddresses")}
          </div>
          <Progress value={progress} className="h-2" />
        </Card>
      )}

      {requestError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{requestError}</AlertDescription>
        </Alert>
      )}

      <div className="grid min-h-[520px] grid-cols-1 gap-4 lg:grid-cols-[minmax(340px,0.8fr)_minmax(0,1.2fr)]">
        <Card className="max-h-[620px] overflow-y-auto">
          <div className="divide-y">
            {visibleRows.map((row) => {
              const rowNumber = rowNumberById.get(row._id) ?? 0;
              const deliveryReady = isValidCoordinate(row.latitude, row.longitude);
              const pickupRequired = Boolean(row.pickupAddress?.trim());
              const pickupReady = !pickupRequired
                || isValidCoordinate(row.pickupLatitude, row.pickupLongitude);
              const sourcePostalCity = getSourcePostalCity(row, "delivery");
              const status = getImportRowStatus(row, {
                addressesResolved: true,
                validationMessages: copy.validation,
              });
              const ready = status === "ready";

              return (
                <div
                  key={row._id}
                  ref={(element) => {
                    if (element) rowRefs.current.set(row._id, element);
                    else rowRefs.current.delete(row._id);
                  }}
                  className={`space-y-3 p-4 ${row._id === mapStopTargets.get(selectedStopId ?? "")?.rowId ? "bg-primary/5" : ""}`}
                  data-import-row-id={row._id}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                        {rowNumber}
                      </span>
                      <span className="truncate text-sm font-medium">
                        {row.contactName || row.referenceNumber || t("import.stopNumber", { number: rowNumber })}
                      </span>
                      {status === "awaitingAddress" && (
                        <span className="text-xs text-amber-600 dark:text-amber-400">
                          {copy.review.addressAwaiting}
                        </span>
                      )}
                      {status === "action" && (
                        <span className="text-xs text-destructive">
                          {copy.status.action}
                        </span>
                      )}
                    </div>
                    {ready ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                    )}
                  </div>

                  {pickupRequired && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">{t("import.pickupAddressLabel")}</label>
                      <Input
                        ref={(element) => {
                          if (element) inputRefs.current.set(`${row._id}-pickup`, element);
                          else inputRefs.current.delete(`${row._id}-pickup`);
                        }}
                        value={row.pickupAddress ?? ""}
                        onChange={(event) => updateAddress(row._id, "pickup", event.target.value)}
                        onClick={() => {
                          if (!pickupReady && !row._pickupCandidates?.length) {
                            lookupAddress(row, "pickup");
                          }
                        }}
                        disabled={isGeocoding}
                        className={`${!pickupReady && !row._pickupCandidates?.length ? "border-amber-400 cursor-pointer" : ""}`}
                        title={!pickupReady ? t("import.clickToSearchGeocode") : undefined}
                        data-testid={`import-address-pickup-${row._id}`}
                      />
                      {pickupReady && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-xs"
                          onClick={() => selectRowStop(`${row._id}-pickup`)}
                        >
                          {i18n.language.toLowerCase().startsWith("sv") ? "Visa på kartan" : "Show on map"}
                        </Button>
                      )}
                      {row._pickupGeocodeError && (
                        <p className="text-xs text-destructive">{row._pickupGeocodeError}</p>
                      )}
                      {renderCandidates(row, "pickup")}
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">{t("import.deliveryAddressLabel")}</label>
                    <Input
                       ref={(element) => {
                         if (element) inputRefs.current.set(`${row._id}-delivery`, element);
                         else inputRefs.current.delete(`${row._id}-delivery`);
                       }}
                      value={row.address}
                      onChange={(event) => updateAddress(row._id, "delivery", event.target.value)}
                      onClick={() => {
                        if (!deliveryReady && !row._deliveryCandidates?.length) {
                          lookupAddress(row, "delivery");
                        }
                      }}
                      disabled={isGeocoding}
                      className={`${!deliveryReady && !row._deliveryCandidates?.length ? "border-amber-400 cursor-pointer" : ""}`}
                      title={!deliveryReady ? t("import.clickToSearchGeocode") : undefined}
                      data-testid={`import-address-delivery-${row._id}`}
                    />
                     {deliveryReady && (
                       <Button
                         type="button"
                         variant="ghost"
                         size="sm"
                         className="h-8 px-2 text-xs"
                         onClick={() => selectRowStop(`${row._id}-delivery`)}
                       >
                         {i18n.language.toLowerCase().startsWith("sv") ? "Visa på kartan" : "Show on map"}
                       </Button>
                     )}
                    {sourcePostalCity && (
                      <p className="text-xs text-muted-foreground">
                        {t("import.sourcePostalCityLabel", {
                          location: sourcePostalCity,
                        })}
                      </p>
                    )}
                    {row._deliveryGeocodeError && (
                      <p className="text-xs text-destructive">{row._deliveryGeocodeError}</p>
                    )}
                    {status === "awaitingAddress" && (
                      <p className="text-xs text-muted-foreground">{copy.review.addressAwaitingDescription}</p>
                    )}
                    {renderCandidates(row, "delivery")}
                  </div>

                  {!ready && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => retryRow(row)}
                      disabled={isGeocoding}
                      className="w-full"
                    >
                      <RefreshCw className="mr-2 h-3.5 w-3.5" />
                      {t("import.searchAddressesAgain")}
                    </Button>
                  )}
                </div>
              );
            })}
            {rows.length === 0 && !(filter === "rejected" && uniqueRejected.length > 0) && (
              <div className="p-8 text-center text-sm text-muted-foreground">{copy.review.noRows}</div>
            )}
            {rows.length > 0
              && visibleRows.length === 0
              && !(filter === "rejected" && uniqueRejected.length > 0) && (
              <div className="p-8 text-center text-sm text-muted-foreground">
                {filter === "rejected" ? copy.review.noRejectedRows : copy.review.noProblems}
              </div>
            )}
            {filter === "rejected" && uniqueRejected.length > 0 && (
              <ul className="space-y-2 p-4 text-sm" data-testid="import-address-rejected-rows">
                {uniqueRejected.map((row) => (
                  <li key={`${row.sourceRowNumber}-${row.reasons.join("|")}`}>
                    <strong>{copy.review.sourceRow} {row.sourceRowNumber}:</strong>{" "}
                    {row.reasons.join(" ")}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <div ref={mapPanelRef} className="min-w-0">
        <GeocodingReviewMap
          stops={mapStops}
          mappedPickupCount={mappedPickupCount}
          mappedDeliveryCount={mappedDeliveryCount}
          selectedStopId={selectedStopId}
          focusStopId={focusStopId}
          stopMarkerLabels={stopMarkerLabels}
          onSelectStop={selectMapStop}
          onClearFocus={() => setFocusStopId(null)}
          onReviewAddress={(stopId) => {
            const target = mapStopTargets.get(stopId);
            if (!target) return;
            focusAddressInput(target.rowId, target.kind);
          }}
        />
        </div>
      </div>

      {!allReady && !isGeocoding && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{t("import.allAddressesRequired")}</span>
            <Button variant="outline" size="sm" onClick={retryAll}>{t("common.retry")}</Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between border-t pt-5">
        <Button variant="ghost" onClick={onBack} disabled={isGeocoding || isSaving}>{t("common.back")}</Button>
        <Button data-testid="planning-draft-save-stops" onClick={handleNext} disabled={!allReady || isGeocoding || isSaving}>
          {isSaving ? t("import.savingStops") : t("import.saveStopsAndCreateRoutes")}
        </Button>
      </div>
    </div>
  );
}
