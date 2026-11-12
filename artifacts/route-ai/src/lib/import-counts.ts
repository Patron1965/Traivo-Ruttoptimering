type ImportEvidenceRecord = Record<string, unknown>;

export type ImportEvidence = {
  receivedRowCount?: number;
  savedRowCount?: number;
  stopIds: string[];
};

function asRecord(value: unknown): ImportEvidenceRecord | null {
  return value && typeof value === "object" ? value as ImportEvidenceRecord : null;
}

function rowCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Import evidence is persisted with the draft by the import endpoint. It is
 * authoritative on resume; parsed rows and React state are only projections
 * and may legitimately be absent after a reload.
 */
export function readImportEvidence(value: unknown): ImportEvidence {
  const record = asRecord(value);
  const stopIds = Array.isArray(record?.stopIds)
    ? record.stopIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : Array.isArray(record?.stops)
      ? record.stops
        .map((stop) => asRecord(stop)?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];

  return {
    receivedRowCount: rowCount(record?.receivedRowCount),
    savedRowCount: rowCount(record?.savedRowCount),
    stopIds: Array.from(new Set(stopIds)),
  };
}

export function resolveImportCounts(input: {
  importedResult?: unknown;
  parsedSourceRowCount?: number;
  hasParsedSourceState: boolean;
  localReceivedRowCount: number;
  localSavedRowCount: number;
  manualSelectedCount: number;
}): { read: number; saved: number } {
  const evidence = readImportEvidence(input.importedResult);
  const read = evidence.receivedRowCount
    ?? input.parsedSourceRowCount
    ?? (input.hasParsedSourceState ? 0 : input.localReceivedRowCount || input.manualSelectedCount);
  const saved = evidence.savedRowCount
    ?? (input.localSavedRowCount > 0 ? input.localSavedRowCount : undefined)
    ?? (input.hasParsedSourceState ? 0 : input.manualSelectedCount);
  return { read, saved };
}

/**
 * Imported stops are the complete order set, including stops that the planner
 * left unplanned. Callers must not add unplannedCount to this value: those
 * identifiers are a partition of the imported set, not additional orders.
 */
export function resolveImportOrderCount(input: {
  importedStopIds?: readonly unknown[];
  importedTotal?: number | null;
  fallbackCount: number;
}): number {
  const uniqueStopIds = new Set(
    (input.importedStopIds ?? []).filter(
      (stopId): stopId is string => typeof stopId === "string" && stopId.length > 0,
    ),
  );
  if (uniqueStopIds.size > 0) return uniqueStopIds.size;
  if (typeof input.importedTotal === "number" && Number.isInteger(input.importedTotal) && input.importedTotal >= 0) {
    return input.importedTotal;
  }
  return Math.max(0, input.fallbackCount);
}