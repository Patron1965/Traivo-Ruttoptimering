import type { Response } from "express";

export function handleError(res: Response, err: unknown): void {
  if (err instanceof Error && err.name === "ZodError" && "issues" in err) {
    const zodErr = err as Error & { issues: unknown[] };
    res.status(400).json({ error: "Validation error", details: zodErr.issues });
    return;
  }
  if (err instanceof Error) {
    res.status(400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: "Internal server error" });
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUuidParam(params: Record<string, string>): { id: string } {
  const id = params.id;
  if (!id || !UUID_REGEX.test(id)) {
    throw new Error("Invalid UUID parameter");
  }
  return { id };
}
