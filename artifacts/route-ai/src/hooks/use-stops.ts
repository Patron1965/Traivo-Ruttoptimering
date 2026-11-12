import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useListStops as useGeneratedListStops,
  useListOrganizationStops as useGeneratedListOrganizationStops,
  useCreateStop as useGeneratedCreateStop,
  useUpdateStop as useGeneratedUpdateStop,
  bulkArchiveStops as generatedBulkArchiveStops,
  bulkDeleteStops,
  type OrganizationStopListItem,
  type StopBulkArchiveInput,
  type StopBulkArchiveResponse,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { invalidateRouteQueries } from "@/lib/route-query-cache";

export function useStops(routeId?: string, reconcileDispatch = false) {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  return useGeneratedListStops(
    routeId ? { organizationId: organizationId!, routeId } : { organizationId: organizationId! },
    { query: {
      queryKey: ["/api/stops", organizationId, routeId], enabled: !!organizationId,
      // Reconcile missed cross-window events even while the socket is unavailable.
      // Match the route list cadence so a move cannot leave stops stale indefinitely.
      refetchInterval: reconcileDispatch ? 15000 : false,
      refetchOnWindowFocus: true,
      ...(reconcileDispatch ? { retry: false as const } : {}),
    } },
  );
}

export type OrganizationStopFilters = {
  search?: string;
  status?: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  workStatus?: "current" | "terminal";
  assignment?: "assigned" | "unassigned";
  routeId?: string;
  orderType?: "single_stop" | "pickup_delivery";
  jobType?: "transport" | "service";
  quality?: "ready" | "issues" | "geocode_error";
  planning?: "planned" | "unplanned";
  timeWindow?: "set" | "unset";
  requirements?: string;
  tracking?: string;
  dateField?: "planned_delivery" | "imported_created";
  dateFrom?: string;
  dateToExclusive?: string;
  includeWithoutPlannedDate?: boolean;
  archiveState?: ArchiveState;
  page: number;
  pageSize: number;
};

export type ArchiveState = "active" | "archived" | "all";

export function useBulkDeleteStops() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (stopIds: string[]) => bulkDeleteStops({ stopIds }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["/api/stops"] });
      void client.invalidateQueries({ queryKey: ["/api/planning"] });
      void client.invalidateQueries({ queryKey: ["planning-drafts"] });
      void invalidateRouteQueries(client);
    },
  });
}

export type OrganizationStop = OrganizationStopListItem;

export function useOrganizationStops(filters: OrganizationStopFilters) {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  return useGeneratedListOrganizationStops(
    { organizationId: organizationId!, ...filters },
    {
      query: {
        queryKey: ["/api/stops", "organization", organizationId, filters],
        enabled: !!organizationId,
        staleTime: 15_000,
      },
    },
  );
}

export function useCreateStop() {
  const queryClient = useQueryClient();
  return useGeneratedCreateStop({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
        void invalidateRouteQueries(queryClient);
      },
    },
  });
}

export function useUpdateStop() {
  const queryClient = useQueryClient();
  return useGeneratedUpdateStop({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
        void invalidateRouteQueries(queryClient);
      },
    },
  });
}

export type StopArchiveResponse = StopBulkArchiveResponse;
export type StopArchiveInput = StopBulkArchiveInput;

export class StopArchiveRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly affectedRouteIds: string[];
  readonly details: unknown;

  constructor(status: number, body: unknown) {
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const details = record.details && typeof record.details === "object"
      ? record.details as Record<string, unknown>
      : undefined;
    super(
      typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : `Could not archive stops (${status})`,
    );
    this.name = "StopArchiveRequestError";
    this.status = status;
    this.code = typeof record.code === "string" ? record.code : undefined;
    const affectedRouteIds = record.affectedRouteIds ?? details?.affectedRouteIds;
    this.affectedRouteIds = Array.isArray(affectedRouteIds)
      ? affectedRouteIds.filter((routeId): routeId is string => typeof routeId === "string")
      : [];
    this.details = body;
  }
}

export function useBulkArchiveStops() {
  const queryClient = useQueryClient();
  return useMutation<StopArchiveResponse, StopArchiveRequestError, { data: StopArchiveInput }>({
    mutationKey: ["bulkArchiveStops"],
    mutationFn: async ({ data }) => {
      try {
        return await generatedBulkArchiveStops(data);
      } catch (error) {
        const responseError = error as { status?: number; data?: unknown };
        throw new StopArchiveRequestError(responseError.status ?? 500, responseError.data ?? error);
      }
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
      queryClient.invalidateQueries({ queryKey: ["/api/planning"] });
      queryClient.invalidateQueries({ queryKey: ["/api/history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/route-history"] });
      queryClient.invalidateQueries({ queryKey: ["planning-drafts"] });
      queryClient.invalidateQueries({ queryKey: ["stop-proofs"] });
      void invalidateRouteQueries(queryClient, result.affectedRouteIds);
    },
  });
}
