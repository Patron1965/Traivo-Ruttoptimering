import type { Stop } from "@workspace/api-client-react";

export type EffectiveStopPriority = 0 | 1 | 2;

export interface DispatchSearchItem {
  stopId: string;
  organizationId: string;
  planId?: string | null;
  routeId?: string | null;
  routeDate?: string | null;
  routeName?: string | null;
  vehicleName?: string | null;
  vehicleLicense?: string | null;
  driverName?: string | null;
  stop: Pick<
    Stop,
    | "id"
    | "address"
    | "pickupAddress"
    | "contactName"
    | "notes"
    | "externalRef"
    | "shopifyOrderName"
    | "trackingCode"
    | "sequenceOrder"
    | "status"
    | "priority"
    | "serviceInstructions"
  >;
  /**
   * The planning snapshot is authoritative for a planned stop. Unassigned
   * stops use their persisted priority because they have no route snapshot.
   */
  effectivePriority?: EffectiveStopPriority;
}

export interface DispatchSearchScope {
  organizationId?: string | null;
  planId?: string | null;
  date?: string | null;
  includeUnassigned?: boolean;
}

export interface DispatchSearchResult extends DispatchSearchItem {
  matchedFields: string[];
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .trim();
}

function indexValue(value: unknown): string {
  const normalized = normalize(value);
  const compact = normalized.replace(/[\s,.-]/g, "");
  return compact && compact !== normalized
    ? `${normalized} ${compact}`
    : normalized;
}

function validPriority(value: unknown): value is EffectiveStopPriority {
  return value === 0 || value === 1 || value === 2;
}

/**
 * Planning uses exactly three persisted values: 0 normal, 1 high, and 2
 * mandatory. The route's effective snapshot takes precedence when it contains
 * the stop; there is deliberately no browser-defined numeric threshold.
 */
export function getEffectiveStopPriority(
  stop: Pick<Stop, "id" | "priority">,
  stopPriorities?: Readonly<Record<string, number>> | null,
): EffectiveStopPriority {
  const snapshotPriority = stopPriorities?.[stop.id];
  if (validPriority(snapshotPriority)) return snapshotPriority;
  if (validPriority(stop.priority)) return stop.priority;
  return 0;
}

export function isStopPrioritized(priority: unknown): priority is 1 | 2 {
  return priority === 1 || priority === 2;
}

export function prioritySearchTerms(priority: EffectiveStopPriority): string[] {
  switch (priority) {
    case 1:
      return ["1", "high", "hog", "hög", "prioritet 1"];
    case 2:
      return ["2", "mandatory", "must", "maste med", "måste med", "prioritet 2"];
    default:
      return ["0", "normal", "prioritet 0"];
  }
}

function statusSearchTerms(status: unknown): string[] {
  const value = normalize(status);
  switch (value) {
    case "pending":
      return ["pending", "vantande", "väntande", "planerad"];
    case "in_progress":
    case "in-progress":
      return ["in_progress", "in progress", "pagaende", "pågående"];
    case "completed":
      return ["completed", "slutford", "slutförd", "levererad"];
    case "failed":
      return ["failed", "misslyckad"];
    case "skipped":
      return ["skipped", "hoppad over", "hoppad över"];
    case "cancelled":
    case "canceled":
      return ["cancelled", "canceled", "avbruten"];
    default:
      return value ? [value] : [];
  }
}

function searchFields(item: DispatchSearchItem): Record<string, string> {
  const stop = item.stop;
  const priority = item.effectivePriority ??
    getEffectiveStopPriority(stop);
  return {
    address: indexValue(stop.address),
    pickupAddress: indexValue(stop.pickupAddress),
    customer: indexValue(stop.contactName),
    notes: indexValue(stop.notes),
    instructions: indexValue(stop.serviceInstructions),
    orderReference: indexValue(stop.externalRef),
    shopifyOrder: indexValue(stop.shopifyOrderName),
    trackingCode: indexValue(stop.trackingCode),
    stopId: indexValue(stop.id || item.stopId),
    sequence: indexValue(stop.sequenceOrder),
    status: [
      normalize(stop.status),
      ...statusSearchTerms(stop.status).map(normalize),
    ].join(" "),
    priority: [
      String(priority),
      ...prioritySearchTerms(priority).map(normalize),
    ].join(" "),
    route: [
      indexValue(item.routeName),
      indexValue(item.routeId),
    ].join(" "),
    vehicle: indexValue(item.vehicleName),
    vehicleRegistration: indexValue(item.vehicleLicense),
    driver: indexValue(item.driverName),
    routeDate: indexValue(item.routeDate),
    plan: indexValue(item.planId),
  };
}

/**
 * Keep search results inside the authenticated dispatch scope. Unassigned
 * stops do not carry plan/date metadata, so they remain available when the
 * caller explicitly includes the current unassigned lane.
 */
export function filterDispatchSearchScope(
  items: readonly DispatchSearchItem[],
  scope: DispatchSearchScope,
): DispatchSearchItem[] {
  return items.filter((item) => {
    if (scope.organizationId && item.organizationId !== scope.organizationId) {
      return false;
    }
    const unassigned = !item.routeId;
    if (scope.planId && item.planId !== scope.planId) {
      return scope.includeUnassigned === true && unassigned;
    }
    if (scope.date && item.routeDate !== scope.date) {
      return scope.includeUnassigned === true && unassigned;
    }
    return true;
  });
}

/**
 * Search is token based: every entered token must occur in at least one
 * dispatch field. This makes combined searches such as a route and driver
 * useful without inventing a field-specific query syntax.
 */
export function searchDispatchItems(
  items: readonly DispatchSearchItem[],
  query: string,
): DispatchSearchResult[] {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return items.map((item) => ({ ...item, matchedFields: [] }));
  }

  return items.flatMap((item) => {
    const fields = searchFields(item);
    const matchedFields = Object.entries(fields)
      .filter(([, value]) => tokens.some((token) => value.includes(token)))
      .map(([key]) => key);
    const matches = tokens.every((token) =>
      Object.values(fields).some((value) => value.includes(token)),
    );
    return matches ? [{ ...item, matchedFields }] : [];
  });
}
