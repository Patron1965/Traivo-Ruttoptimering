/**
 * Pure description of a timeline drop insertion point. `index` is the visual
 * index into the target row's remaining (not dragged, visible) stops, never the
 * API index. Labels reference the real sequenceOrder of the next visible anchor
 * stop; previous neighbours are never claimed because hidden/filtered stops may
 * sit between them and the anchor.
 */
export type InsertionPlacement = "empty" | "first" | "middle" | "last";

export interface InsertionDescription {
  placement: InsertionPlacement;
  /** sequenceOrder of the visible anchor the drop lands before, if any. */
  beforeOrder: number | null;
}

export function describeInsertion(
  index: number,
  remainingStops: ReadonlyArray<{ sequenceOrder?: number | null }>,
): InsertionDescription {
  const total = remainingStops.length;
  if (total === 0) return { placement: "empty", beforeOrder: null };
  const i = Number.isFinite(index) ? Math.max(0, Math.min(Math.floor(index), total)) : total;
  if (i >= total) return { placement: "last", beforeOrder: null };
  const order = remainingStops[i]?.sequenceOrder;
  return {
    placement: i === 0 ? "first" : "middle",
    beforeOrder: typeof order === "number" && Number.isFinite(order) ? order : null,
  };
}

/** Which side the caption sits on so it stays inside the row grid. */
export function insertionLabelSide(x: number, gridWidth: number, labelWidth = 168): "right" | "left" {
  return x + labelWidth + 8 > gridWidth && x - labelWidth - 8 >= 0 ? "left" : "right";
}
