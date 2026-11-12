/** Keep device telemetry separate from the authoritative route lifecycle. */
export async function finishTrackingSession<T>(
  endOnServer: () => Promise<T>,
  stopOnDevice: () => Promise<void>,
): Promise<T> {
  const ended = await endOnServer();
  // In particular, don't clear the session in finally: a rejection or a lost
  // response must retain its identity so work can continue or end can retry.
  await stopOnDevice();
  return ended;
}

export function trackingStartIdentity(
  existing: { status: "active" | "ended"; clientSessionId: string } | null,
  createId: () => string,
): { clientSessionId: string; occurredAt?: string } {
  if (existing) {
    // The original start may have occurred on another device. Don't give its
    // replay a new timestamp; the server still checks the accepted revision
    // and whether an older prematurely-ended execution can safely reopen.
    return { clientSessionId: existing.clientSessionId };
  }
  return { clientSessionId: createId(), occurredAt: new Date().toISOString() };
}

export function hasUnresolvedTrackingStops(
  stops: readonly { status: string }[] | undefined,
): boolean {
  return !stops || stops.some((stop) => !["completed", "failed", "skipped"].includes(stop.status));
}