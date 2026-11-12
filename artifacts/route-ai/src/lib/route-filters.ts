export type RouteStatusFilter = "all" | "active" | "drafts" | "completed";

export interface RouteFilterable {
  id: string;
  status: string;
  name?: string | null;
  date?: string | null;
}

export interface RouteSearchFields {
  vehicleName?: string | null;
  vehicleLicense?: string | null;
  driverName?: string | null;
}

export interface RouteFilterGroup<Route extends RouteFilterable> {
  routes: Route[];
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .trim();
}

function statusMatches(status: string, filter: RouteStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return status === "optimized" || status === "in_progress";
  if (filter === "drafts") return status === "draft";
  return status === "completed" || status === "cancelled";
}

/**
 * Filter grouped plans without changing the grouping model. A plan-name
 * match keeps every route in the plan (subject to the status filter), while a
 * vehicle/driver/route/date match keeps only the matching children.
 */
export function filterRoutePlanGroups<
  Route extends RouteFilterable,
  Group extends RouteFilterGroup<Route>,
>(
  groups: readonly Group[],
  options: {
    query?: string;
    status: RouteStatusFilter;
    getPlanTitle: (group: Group) => string;
    getSearchFields: (route: Route) => RouteSearchFields;
  },
): Group[] {
  const query = normalize(options.query);
  return groups.flatMap((group) => {
    const planTitleMatches = !query || normalize(options.getPlanTitle(group)).includes(query);
    const routes = group.routes.filter((route) => {
      if (!statusMatches(route.status, options.status)) return false;
      if (planTitleMatches || !query) return true;
      const fields = options.getSearchFields(route);
      return [
        route.name,
        route.date,
        fields.vehicleName,
        fields.vehicleLicense,
        fields.driverName,
      ].some((value) => normalize(value).includes(query));
    });
    return routes.length > 0 ? [{ ...group, routes }] : [];
  });
}