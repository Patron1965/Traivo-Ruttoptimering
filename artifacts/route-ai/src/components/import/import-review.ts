import { isValidCoordinate } from "../../lib/map-utils.ts";
import type { MappedRow, RejectedImportRow } from "./types";
import type { ImportReviewCopy } from "./import-review-copy";

export type ImportReviewFilter = "problems" | "all" | "ready" | "rejected";
export type ImportRowStatus = "ready" | "action" | "awaitingAddress";

export type ValidationMessages = ImportReviewCopy["validation"];

const DEFAULT_VALIDATION_MESSAGES: ValidationMessages = {
  addressMissing: "Leveransadress saknas.",
  dateMissing: "Datum saknas.",
  negativeWeight: "Vikten får inte vara negativ.",
  negativeVolume: "Volymen får inte vara negativ.",
  invalidTimeWindow: "Tidsfönstrets sluttid måste vara efter starttiden.",
};

function uniqueMessages(messages: string[]): string[] {
  return Array.from(new Set(messages.filter((message) => message.trim() !== "")));
}

/**
 * Validate the fields that must be correct before a row can be considered
 * ready.  The source-row identity is intentionally not part of validation:
 * one source row may have several reasons, but it still contributes one
 * action/rejected count.
 */
export function validateMappedRow(
  row: MappedRow,
  messages: ValidationMessages = DEFAULT_VALIDATION_MESSAGES,
): string[] {
  const errors = [...(row._mappingErrors ?? [])].filter(
    (error): error is string => typeof error === "string",
  );
  if (!row.address || row.address.trim() === "") errors.push(messages.addressMissing);
  if (!row.date || row.date.trim() === "") errors.push(messages.dateMissing);
  if (row.weightKg != null && (!Number.isFinite(row.weightKg) || row.weightKg < 0)) {
    errors.push(messages.negativeWeight);
  }
  if (row.volumeM3 != null && (!Number.isFinite(row.volumeM3) || row.volumeM3 < 0)) {
    errors.push(messages.negativeVolume);
  }
  if (row.timeWindowStart && row.timeWindowEnd && row.timeWindowStart >= row.timeWindowEnd) {
    errors.push(messages.invalidTimeWindow);
  }
  return uniqueMessages(errors);
}

export function hasRequiredFields(row: MappedRow): boolean {
  return Boolean(row.address?.trim() && row.date?.trim());
}

export function isMappedRowAddressReady(row: MappedRow): boolean {
  const pickupRequired = Boolean(row.pickupAddress?.trim());
  return isValidCoordinate(row.latitude, row.longitude)
    && (!pickupRequired || isValidCoordinate(row.pickupLatitude, row.pickupLongitude));
}

export function getImportRowStatus(
  row: MappedRow,
  options: {
    addressesResolved?: boolean;
    validationMessages?: ValidationMessages;
  } = {},
): ImportRowStatus {
  if (validateMappedRow(row, options.validationMessages).length > 0) return "action";
  if (options.addressesResolved && !isMappedRowAddressReady(row)) return "awaitingAddress";
  return "ready";
}

export function matchesImportReviewFilter(
  status: ImportRowStatus,
  filter: ImportReviewFilter,
): boolean {
  switch (filter) {
    case "problems":
      return status !== "ready";
    case "ready":
      return status === "ready";
    case "all":
      return true;
    case "rejected":
      return false;
  }
}

export type ImportReviewCounts = {
  /** Number of unique source rows represented by mapped or rejected rows. */
  total: number;
  sourceRows: number;
  mapped: number;
  validated: number;
  ready: number;
  /** Action includes valid rows that are still awaiting address resolution. */
  action: number;
  awaitingAddress: number;
  /** Alias kept explicit for surfaces that label this state in full. */
  validAwaitingAddress: number;
  rejected: number;
};

function sourceRowKey(sourceRowNumber: number): string {
  return String(sourceRowNumber);
}

function uniqueMappedRows(rows: MappedRow[]): MappedRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = sourceRowKey(row._sourceRowNumber);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function uniqueRejectedRows(rows: RejectedImportRow[]): RejectedImportRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = sourceRowKey(row.sourceRowNumber);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Reconcile UI counts by source-row identity instead of by error or address.
 * In particular, a row with three validation errors is still one action row,
 * and a row carrying both delivery and pickup problems is still one row.
 */
export function reconcileImportReviewCounts(
  rows: MappedRow[],
  rejectedRows: RejectedImportRow[] = [],
  options: {
    addressesResolved?: boolean;
    validationMessages?: ValidationMessages;
  } = {},
): ImportReviewCounts {
  const deduplicatedRejectedRows = uniqueRejectedRows(rejectedRows);
  const uniqueRejectedKeys = new Set(
    deduplicatedRejectedRows.map((row) => sourceRowKey(row.sourceRowNumber)),
  );
  const mappedRows = uniqueMappedRows(rows).filter(
    (row) => !uniqueRejectedKeys.has(sourceRowKey(row._sourceRowNumber)),
  );
  const representedKeys = new Set([
    ...mappedRows.map((row) => sourceRowKey(row._sourceRowNumber)),
    ...uniqueRejectedKeys,
  ]);
  const statuses = mappedRows.map((row) => getImportRowStatus(row, options));
  const ready = statuses.filter((status) => status === "ready").length;
  const awaitingAddress = statuses.filter((status) => status === "awaitingAddress").length;
  const rejected = uniqueRejectedKeys.size;

  return {
    total: representedKeys.size,
    sourceRows: representedKeys.size,
    mapped: mappedRows.length,
    validated: mappedRows.length,
    ready,
    action: mappedRows.length - ready,
    awaitingAddress,
    validAwaitingAddress: awaitingAddress,
    rejected,
  };
}

/**
 * Merge an inline correction without ever replacing the source-row identity.
 * This helper is also useful to callers that keep rows outside React state.
 */
export function updateMappedRowById(
  rows: MappedRow[],
  id: string,
  updates: Partial<MappedRow>,
): MappedRow[] {
  return rows.map((row) => {
    if (row._id !== id) return row;
    return {
      ...row,
      ...updates,
      _id: row._id,
      _sourceRowNumber: row._sourceRowNumber,
      _sourceValues: row._sourceValues,
    };
  });
}

export function filterMappedRows(
  rows: MappedRow[],
  filter: ImportReviewFilter,
  options: {
    addressesResolved?: boolean;
    validationMessages?: ValidationMessages;
  } = {},
): MappedRow[] {
  // Rejected rows are a separate source-row projection (they do not have an
  // editable MappedRow anymore), so the caller renders that projection
  // alongside this empty mapped-row result.
  return rows.filter((row) =>
    matchesImportReviewFilter(getImportRowStatus(row, options), filter),
  );
}