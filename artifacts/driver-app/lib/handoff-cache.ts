import type { Route } from "./api";

type HandoffRoute = Pick<Route, "id" | "planRevision" | "handoffVersion" | "handoffStatus">;
const rank = { pending: 0, sent: 1, received: 2, opened: 3, accepted: 4, rejected: 4 };

/** An asynchronous acknowledgement must never revoke a newer cached decision. */
export function mergeHandoffResponse<T extends HandoffRoute>(current: T, updated: T): T {
  if (updated.id !== current.id
    || updated.handoffVersion < current.handoffVersion
    || updated.planRevision < current.planRevision) return current;
  if (updated.handoffVersion === current.handoffVersion) {
    if (rank[updated.handoffStatus] < rank[current.handoffStatus]) return current;
    if ((current.handoffStatus === "accepted" || current.handoffStatus === "rejected")
      && updated.handoffStatus !== current.handoffStatus) return current;
  }
  return updated;
}
