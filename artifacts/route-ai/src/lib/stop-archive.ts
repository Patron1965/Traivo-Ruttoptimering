export type ArchiveSnapshotMismatch = {
  missingIds: string[];
  unexpectedIds: string[];
};

/**
 * Freeze the IDs selected by the user at the point the confirmation dialog
 * opens. The returned array is intentionally independent of the source Set so
 * later selection changes cannot mutate the request.
 */
export function createArchiveSnapshot(stopIds: readonly string[]): string[] {
  return Array.from(new Set(stopIds));
}

function asIdSet(ids: readonly string[]): Set<string> {
  return new Set(ids);
}

/**
 * Compare a fixed confirmation snapshot with the IDs returned by an
 * authoritative refresh. Order is not meaningful, but additions and removals
 * are explicit conflicts rather than silently changing what the user
 * confirmed.
 */
export function compareArchiveSnapshot(
  snapshot: readonly string[],
  authoritativeIds: readonly string[],
): ArchiveSnapshotMismatch {
  const expected = asIdSet(snapshot);
  const actual = asIdSet(authoritativeIds);
  return {
    missingIds: snapshot.filter((id) => !actual.has(id)),
    unexpectedIds: authoritativeIds.filter((id) => !expected.has(id)),
  };
}

export function assertArchiveSnapshotUnchanged(
  snapshot: readonly string[],
  authoritativeIds: readonly string[],
): void {
  const mismatch = compareArchiveSnapshot(snapshot, authoritativeIds);
  if (mismatch.missingIds.length === 0 && mismatch.unexpectedIds.length === 0) return;

  const error = new Error("The selected stops changed while confirmation was open.");
  error.name = "ArchiveSnapshotChangedError";
  Object.assign(error, { mismatch });
  throw error;
}

export function isArchivedStop(stop: { archivedAt?: string | null }): boolean {
  return stop.archivedAt != null;
}