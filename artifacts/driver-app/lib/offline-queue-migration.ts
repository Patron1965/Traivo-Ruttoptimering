export type LegacyQueuedMutation = {
  id: string;
  type: "updateStopStatus";
  stopId: string;
  status: string;
  timestamp: number;
  planVersion?: number;
  skipReason?: string;
  comment?: string;
  actualDurationMin?: number;
};

export type LegacyQueuedProof = {
  id: string;
  stopId: string;
  proofType: "photo" | "signature" | "barcode";
  proofStage: "pickup" | "delivery";
  data: string;
  notes?: string;
  timestamp: number;
  clientEventId?: string;
  planVersion?: number;
  occurredAt?: string;
};

export type LegacyQueuedServiceReport = {
  id: string;
  stopId: string;
  report: unknown;
  proofs?: Array<{
    type: "photo" | "signature";
    data: string;
    notes?: string;
    clientEventId?: string;
    planVersion?: number;
    occurredAt?: string;
  }>;
  timestamp: number;
};

export type MigratedQueuedMutation = LegacyQueuedMutation & { planVersion: number };
export type MigratedQueuedProof = LegacyQueuedProof & {
  clientEventId: string;
  planVersion: number;
  occurredAt: string;
};
export type MigratedQueuedServiceReport = LegacyQueuedServiceReport & {
  proofs?: Array<{
    type: "photo" | "signature";
    data: string;
    notes?: string;
    clientEventId: string;
    planVersion: number;
    occurredAt: string;
  }>;
};

export type LegacyPlanVersionResolver = (stopId: string) => Promise<number | null>;

function occurredAtFromTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(timestamp) || Number.isNaN(date.getTime())) {
    throw new Error("Legacy offline event has an invalid timestamp");
  }
  return date.toISOString();
}

async function resolvePlanVersion(
  stopId: string,
  existing: number | undefined,
  resolver: LegacyPlanVersionResolver,
): Promise<number> {
  if (Number.isInteger(existing) && existing! >= 0) return existing!;
  const resolved = await resolver(stopId);
  if (!Number.isInteger(resolved) || resolved! < 0) {
    throw new Error(`Cannot resolve the accepted plan version for queued stop ${stopId}`);
  }
  return resolved!;
}

export function executionEventTypeForStatus(
  status: string,
): "completed" | "failed" | "skipped" {
  if (status === "completed" || status === "failed" || status === "skipped") return status;
  throw new Error(`Unsupported terminal stop status: ${status}`);
}

export async function migrateLegacyExecutionQueues(
  queues: {
    statuses: LegacyQueuedMutation[];
    proofs: LegacyQueuedProof[];
    serviceReports: LegacyQueuedServiceReport[];
  },
  resolveCurrentPlanVersion: LegacyPlanVersionResolver,
): Promise<{
  statuses: MigratedQueuedMutation[];
  proofs: MigratedQueuedProof[];
  serviceReports: MigratedQueuedServiceReport[];
}> {
  const planVersionByStop = new Map<string, Promise<number>>();
  const versionFor = (stopId: string, existing?: number) => {
    if (Number.isInteger(existing) && existing! >= 0) return Promise.resolve(existing!);
    let pending = planVersionByStop.get(stopId);
    if (!pending) {
      pending = resolvePlanVersion(stopId, existing, resolveCurrentPlanVersion);
      planVersionByStop.set(stopId, pending);
    }
    return pending;
  };

  const statuses: MigratedQueuedMutation[] = [];
  for (const item of queues.statuses) {
    statuses.push({ ...item, planVersion: await versionFor(item.stopId, item.planVersion) });
  }

  const proofs: MigratedQueuedProof[] = [];
  for (const item of queues.proofs) {
    proofs.push({
      ...item,
      clientEventId: item.clientEventId ?? item.id,
      planVersion: await versionFor(item.stopId, item.planVersion),
      occurredAt: item.occurredAt ?? occurredAtFromTimestamp(item.timestamp),
    });
  }

  const serviceReports: MigratedQueuedServiceReport[] = [];
  for (const item of queues.serviceReports) {
    const migratedProofs = [];
    for (const [index, proof] of (item.proofs ?? []).entries()) {
      migratedProofs.push({
        ...proof,
        clientEventId: proof.clientEventId ?? `${item.id}_proof_${index}`,
        planVersion: await versionFor(item.stopId, proof.planVersion),
        occurredAt: proof.occurredAt ?? occurredAtFromTimestamp(item.timestamp),
      });
    }
    serviceReports.push({
      ...item,
      proofs: item.proofs ? migratedProofs : undefined,
    });
  }

  return { statuses, proofs, serviceReports };
}