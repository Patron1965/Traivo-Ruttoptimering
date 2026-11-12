/** Resolve only an unambiguous, visible route and load its complete active plan. */
export function resolveMapPlanTarget<T extends { id: string; planId?: string | null; status: string }>(
  visibleRoutes: readonly T[], selected: ReadonlySet<string>, allRoutes: readonly T[],
) {
  const targetId = selected.size === 1 ? [...selected][0]
    : selected.size === 0 && visibleRoutes.length === 1 ? visibleRoutes[0].id : null;
  const route = visibleRoutes.some(item => item.id === targetId)
    ? allRoutes.find(item => item.id === targetId) : undefined;
  const planRoutes = route?.planId
    ? allRoutes.filter(item => item.planId === route.planId && item.status !== "cancelled") : [];
  return { route, planRoutes };
}

export function resourceEditBlockReason(
  routes: readonly { status: string; sentAt?: unknown; handoffStatus?: string | null }[],
  hasDepot: boolean,
): string | null {
  if (!routes.length) return "Projektet saknar en sammanhängande arbetsplan. Öppna projektet och slutför planeringen först.";
  if (routes.some(route => !["draft", "optimized"].includes(route.status) || route.sentAt
    || (route.handoffStatus != null && route.handoffStatus !== "pending"))) {
    return "Resurser kan inte ändras när någon rutt är skickad, påbörjad eller avslutad.";
  }
  if (routes.some(route => route.status === "draft")) return "Öppna projektets planering för att välja resurser och optimera utkastet först.";
  if (!hasDepot) return "Depån saknas i planeringsunderlaget. Öppna projektet och ange depå innan du ändrar resurser.";
  return null;
}
