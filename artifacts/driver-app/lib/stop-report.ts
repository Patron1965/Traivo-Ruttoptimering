export const SKIP_REASONS = ["CUSTOMER_UNAVAILABLE", "ACCESS_BLOCKED", "ADDRESS_NOT_FOUND", "VEHICLE_OR_SAFETY", "OTHER"] as const;
export type SkipReason = typeof SKIP_REASONS[number];
export const isSkipReason = (value: unknown): value is SkipReason =>
  typeof value === "string" && (SKIP_REASONS as readonly string[]).includes(value);

export interface StopReport {
  id: string;
  stopId: string;
  routeId: string;
  planVersion: number;
  occurredAt: string;
  outcome: "completed" | "failed" | "skipped";
  /** Required for skipped; custom categories map to OTHER with the label frozen in comment. */
  skipReason?: SkipReason;
  stage: "pickup" | "delivery";
  comment?: string;
  proofs: Array<{ type: "photo" | "signature" | "barcode"; data: string }>;
}

export interface StopReportPort {
  getStop: (id: string) => Promise<{ routeId: string; jobType?: string }>;
  proof: (id: string, input: {
    proofType: "photo" | "signature" | "barcode"; proofStage: "pickup" | "delivery";
    data: string; clientEventId: string; planVersion: number; occurredAt: string; notes?: string;
  }) => Promise<unknown>;
  event: (id: string, input: {
    type: "completed" | "failed" | "skipped"; skipReason?: SkipReason; clientEventId: string; planVersion: number; occurredAt: string; comment?: string;
  }) => Promise<unknown>;
  pickup: (routeId: string, stopId: string, version: number, occurredAt: string) => Promise<unknown>;
}

/** Replays the same immutable operation IDs; status is never sent before media. */
export async function sendStopReport(report: StopReport, port: StopReportPort) {
  if (report.outcome === "skipped" && !isSkipReason(report.skipReason)) {
    throw Object.assign(new Error("SKIP_REASON_REQUIRED"), { status: 400, code: "SKIP_REASON_REQUIRED" });
  }
  const stop = await port.getStop(report.stopId);
  if (stop.routeId !== report.routeId || stop.jobType === "field_service") {
    throw Object.assign(new Error("REPORT_CONTEXT_CHANGED"), { status: 409, code: "STALE_PLAN" });
  }
  for (const [index, proof] of report.proofs.entries()) {
    await port.proof(report.stopId, {
      proofType: proof.type, proofStage: report.stage, data: proof.data,
      clientEventId: `${report.id}:proof:${index}`, planVersion: report.planVersion,
      occurredAt: report.occurredAt, notes: report.comment,
    });
  }
  if (report.stage === "pickup" && report.outcome === "completed") {
    await port.pickup(report.routeId, report.stopId, report.planVersion, report.occurredAt);
  } else {
    await port.event(report.stopId, {
      type: report.outcome,
      ...(report.outcome === "skipped" ? { skipReason: report.skipReason } : {}),
      clientEventId: `${report.id}:outcome`,
      planVersion: report.planVersion, occurredAt: report.occurredAt, comment: report.comment,
    });
  }
}
