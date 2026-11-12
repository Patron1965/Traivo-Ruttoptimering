/** Only server-authenticated identity may partition the operational budget. */
export function operationalRateKey(req: {
  method: string;
  ip?: string;
  user?: { id: string; organizationId: string } | null;
}): string {
  if (!req.user?.organizationId || !req.user.id) return req.ip ?? "unknown";
  const operation = req.method === "GET" || req.method === "HEAD" ? "read" : "write";
  return `${req.user.organizationId}:${req.user.id}:${operation}`;
}
