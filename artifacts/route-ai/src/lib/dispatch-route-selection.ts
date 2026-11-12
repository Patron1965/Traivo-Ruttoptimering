/** Driver selection is visual only; operational actions require exactly one route. */
export function selectDriverRoute(
  current: ReadonlySet<string>,
  routeId: string,
  additive: boolean,
): Set<string> {
  if (!additive) return new Set([routeId]);
  const next = new Set(current);
  if (next.has(routeId)) next.delete(routeId);
  else next.add(routeId);
  return next;
}

export function reconcileDriverRoutes(
  current: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
): Set<string> {
  return new Set([...current].filter((id) => allowed.has(id)));
}

export function singleDriverRoute(current: ReadonlySet<string>): string | null {
  return current.size === 1 ? [...current][0] : null;
}

export function routeHighlight(
  routeId: string,
  selected: ReadonlySet<string>,
  preserveVisibility = false,
) {
  return {
    isHighlighted: selected.has(routeId),
    isDimmed: !preserveVisibility && selected.size > 0 && !selected.has(routeId),
  };
}
