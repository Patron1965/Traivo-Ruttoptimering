export interface DistrictQueueCandidate {
  jobId: string;
  organizationId: string;
  planId: string;
  createdAt: Date;
  lastStartedAt: Date | null;
}

/** Select the least recently served tenant, preserving FIFO across its plans. */
export function sortDistrictQueueCandidates<T extends DistrictQueueCandidate>(candidates: T[]): T[] {
  return candidates.slice().sort((a, b) => {
    if (a.lastStartedAt === null && b.lastStartedAt !== null) return -1;
    if (b.lastStartedAt === null && a.lastStartedAt !== null) return 1;
    if (a.lastStartedAt && b.lastStartedAt) {
      const tenantOrder = a.lastStartedAt.getTime() - b.lastStartedAt.getTime();
      if (tenantOrder) return tenantOrder;
    }
    return a.createdAt.getTime() - b.createdAt.getTime() || a.jobId.localeCompare(b.jobId);
  });
}