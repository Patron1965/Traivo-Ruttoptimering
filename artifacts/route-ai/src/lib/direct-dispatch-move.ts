export type DirectMoveSnapshot = {
  stopIds: string[];
  routeId: string | null;
  targetIndex: number;
  routeRevisions: { routeId: string; planRevision: number }[];
  force: false;
};

export type DirectMoveResult = { conflicts: string[]; status?: number; error?: string; refreshFailed?: boolean };

/** One attempt only. In particular, authentication recovery must not replay a move. */
export async function attemptDirectDispatchMove(options: {
  enabled: boolean;
  canEdit: boolean;
  snapshot: DirectMoveSnapshot;
  isCurrent: () => boolean;
  preview: (snapshot: DirectMoveSnapshot) => Promise<unknown>;
  commit: (snapshot: DirectMoveSnapshot, digest: string) => Promise<DirectMoveResult>;
}): Promise<"review" | "saved" | "saved-refresh-failed" | "cancelled"> {
  if (!options.isCurrent()) return "cancelled";
  if (!options.enabled || !options.canEdit) return "review";
  try {
    const result = await options.preview(options.snapshot) as {
      canMove?: unknown; conflicts?: unknown; previewDigest?: unknown;
    } | null;
    if (!options.isCurrent()) return "cancelled";
    if (!result || result.canMove !== true || !Array.isArray(result.conflicts)
      || result.conflicts.length !== 0 || typeof result.previewDigest !== "string"
      || !/^[a-f0-9]{64}$/i.test(result.previewDigest)) return "review";
    const committed = await options.commit(options.snapshot, result.previewDigest);
    if (!options.isCurrent()) return "cancelled";
    if (committed.status === 409 || committed.error || committed.conflicts.length) return "review";
    return committed.refreshFailed ? "saved-refresh-failed" : "saved";
  } catch {
    return options.isCurrent() ? "review" : "cancelled";
  }
}
