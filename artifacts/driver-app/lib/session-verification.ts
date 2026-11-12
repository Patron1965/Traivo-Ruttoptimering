// React consumers subscribe to this status instead of reading a nonreactive
// module boolean. Connectivity alone never grants authenticated access.
let verified = false;
const listeners = new Set<() => void>();
let verifySession: (() => Promise<boolean>) | null = null;

export function setSessionVerificationHandler(handler: (() => Promise<boolean>) | null) {
  verifySession = handler;
}

/** Verify before sending, never replay a mutation after an uncertain response. */
export async function ensureServerSessionVerified(): Promise<boolean> {
  if (verified) return true;
  const handler = verifySession;
  if (!handler) return false;
  await handler();
  // The callback's result alone cannot authorize a request after logout.
  return handler === verifySession && verified;
}

export function isServerSessionVerified(): boolean {
  return verified;
}

export function subscribeToSessionVerification(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setServerSessionVerified(value: boolean): void {
  if (verified === value) return;
  verified = value;
  for (const listener of listeners) listener();
}
