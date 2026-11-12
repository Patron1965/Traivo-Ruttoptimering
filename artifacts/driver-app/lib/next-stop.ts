import type { Stop } from "./api";

export function getNextPendingStop(stops: readonly Stop[]): Stop | undefined {
  return [...stops]
    .sort(
      (a, b) =>
        (a.sequenceOrder ?? Number.MAX_SAFE_INTEGER)
        - (b.sequenceOrder ?? Number.MAX_SAFE_INTEGER),
    )
    .find((stop) => stop.status === "pending");
}