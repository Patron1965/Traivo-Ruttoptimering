import type {
  AssignedRoute,
  Driver,
  RouteDispatchResult,
  RouteResendSmsResult,
  Stop,
  Vehicle,
} from "@workspace/api-client-react";
import { TrustedLocalizedError } from "@/lib/localize-error";

export type SystemField = {
  key: string;
  labelKey: string;
  required: boolean;
  description: string;
  apiField: string;
  exampleValue: string;
  forMode?: "transport" | "field_service";
};

export interface MappedRow extends Record<string, unknown> {
  _id: string;
  _sourceRowNumber: number;
  _sourceValues: string[];
  _mappingErrors?: string[];
  /** True when the address target was composed from ordered source columns. */
  _deliveryAddressComposed?: boolean;
  address: string;
  postalCode?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  referenceNumber?: string;
  date?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  timeWindowStart?: string;
  timeWindowEnd?: string;
  serviceDurationMin?: number;
  weightKg?: number;
  volumeM3?: number;
  notes?: string;
  pickupAddress?: string;
  pickupLatitude?: number;
  pickupLongitude?: number;
  jobType?: string;
  serviceCategory?: string;
  priority?: number;
  slaDeadline?: string;
  serviceInstructions?: string;
  requiredSkills?: string;
  requiredCertifications?: string;
  requiredEquipment?: string;
  _deliveryGeocodeError?: string;
  _pickupGeocodeError?: string;
  _deliveryCandidates?: GeocodeCandidate[];
  _pickupCandidates?: GeocodeCandidate[];
  // Custom fields will be stored under keys starting with 'custom_'
}

export interface RejectedImportRow {
  sourceRowNumber: number;
  values: string[];
  reasons: string[];
}

export type GeocodeResult = {
  latitude: number;
  longitude: number;
  displayName: string;
  source: "google" | "nominatim" | "cache";
  provider: "google" | "nominatim";
};

export type GeocodeCandidate = {
  id: string;
  latitude: number;
  longitude: number;
  displayName: string;
  source: "google" | "nominatim";
  partial: boolean;
};

export type ImportStop = Stop;
export type ImportVehicle = Vehicle;
export type ImportDriver = Driver;
export type ImportAssignedRoute = AssignedRoute;
export type ImportDispatchResult = RouteDispatchResult;
export type ImportResendResult = RouteResendSmsResult;

export interface ExpectedApprovedRoute {
  routeId: string;
  planRevision: number;
  driverId: string;
}

/**
 * Approval is authoritative only when the server confirms the protected plan,
 * the complete route set, and every exact recipient/revision tuple.
 */
export function hasExactApprovedRouteSet(
  result: {
    protected: boolean;
    routes: Array<{
      routeId: string;
      planRevision: number;
      driverId: string | null;
      approval: { approved: boolean };
    }>;
  },
  expected: ExpectedApprovedRoute[],
): boolean {
  if (!result.protected || result.routes.length !== expected.length) return false;
  const expectedById = new Map(expected.map((route) => [route.routeId, route]));
  return result.routes.every((route) => {
    const expectedRoute = expectedById.get(route.routeId);
    return Boolean(
      expectedRoute
      && route.planRevision === expectedRoute.planRevision
      && route.driverId === expectedRoute.driverId
      && route.approval.approved,
    );
  }) && expectedById.size === result.routes.length;
}

export function getApiErrorMessage(error: unknown, fallback: TrustedLocalizedError): string {
  return error instanceof TrustedLocalizedError ? error.message : fallback.message;
}
