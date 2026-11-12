/**
 * Resolve a pointer position from a filtered timeline against the canonical
 * route order sent to the dispatch-move API.
 *
 * The visible timeline may omit stops while a search is active. An ordinal
 * computed from those visible blocks is not a safe API insertion index because
 * hidden stops still occupy positions in the canonical route. Instead, the
 * first visible block after the pointer is an anchor; insertion happens before
 * that anchor after dragged stops have been removed from the target route.
 */
export function canonicalInsertionIndex({
  canonicalStopIds,
  draggedStopIds,
  anchorStopId,
}: {
  canonicalStopIds: readonly string[];
  draggedStopIds: readonly string[];
  anchorStopId?: string | null;
}): number {
  const dragged = new Set(draggedStopIds);
  const remaining = canonicalStopIds.filter((stopId) => !dragged.has(stopId));
  if (!anchorStopId) return remaining.length;
  const anchorIndex = remaining.indexOf(anchorStopId);
  return anchorIndex >= 0 ? anchorIndex : remaining.length;
}
