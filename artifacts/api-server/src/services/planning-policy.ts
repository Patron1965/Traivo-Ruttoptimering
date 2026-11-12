import type { ALNSVehicle } from "./alns/types";

/**
 * Organization-owned route feasibility allowances. These values deliberately
 * have a single bounded normalizer so every planning/mutation entry point
 * applies the same defaults and rejects malformed persisted settings.
 */
export const MAX_PLANNING_ALLOWANCE_MIN = 24 * 60;

export type OrganizationPlanningPolicy = {
  maxDriverOvertimeMin: number;
  allowLateStopsMin: number;
};

export const DEFAULT_ORGANIZATION_PLANNING_POLICY: OrganizationPlanningPolicy = {
  maxDriverOvertimeMin: 0,
  allowLateStopsMin: 0,
};

export function normalizePlanningAllowance(value: unknown, fieldName: string): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_PLANNING_ALLOWANCE_MIN) {
    throw new Error(`${fieldName} must be an integer between 0 and ${MAX_PLANNING_ALLOWANCE_MIN}.`);
  }
  return value;
}

export function normalizeOrganizationPlanningPolicy(value: Partial<OrganizationPlanningPolicy> | null | undefined): OrganizationPlanningPolicy {
  return {
    maxDriverOvertimeMin: normalizePlanningAllowance(
      value?.maxDriverOvertimeMin,
      "maxDriverOvertimeMin",
    ),
    allowLateStopsMin: normalizePlanningAllowance(
      value?.allowLateStopsMin,
      "allowLateStopsMin",
    ),
  };
}

export function organizationPlanningPolicy(
  organization: {
    maxDriverOvertimeMin?: number | null;
    allowLateStopsMin?: number | null;
  } | null | undefined,
): OrganizationPlanningPolicy {
  return {
    maxDriverOvertimeMin: normalizePlanningAllowance(
      organization?.maxDriverOvertimeMin,
      "maxDriverOvertimeMin",
    ),
    allowLateStopsMin: normalizePlanningAllowance(
      organization?.allowLateStopsMin,
      "allowLateStopsMin",
    ),
  };
}

export function withOrganizationPlanningPolicy<T extends ALNSVehicle>(
  vehicle: T,
  policy: OrganizationPlanningPolicy,
): T {
  return {
    ...vehicle,
    maxDriverOvertimeMin: policy.maxDriverOvertimeMin,
    allowLateStopsMin: policy.allowLateStopsMin,
  };
}

/**
 * A plan may tighten organization allowances (including explicit zero), never
 * silently relax them. Missing legacy fields inherit the organization limit.
 * Read the raw snapshot, before normalizers fill absent fields with zero.
 */
export function effectivePlanningPolicy(
  organization: { maxDriverOvertimeMin?: number | null; allowLateStopsMin?: number | null } | null | undefined,
  plan: Partial<OrganizationPlanningPolicy> | null | undefined,
): OrganizationPlanningPolicy {
  const policy = organizationPlanningPolicy(organization);
  return {
    maxDriverOvertimeMin: plan?.maxDriverOvertimeMin == null
      ? policy.maxDriverOvertimeMin
      : Math.min(policy.maxDriverOvertimeMin, normalizePlanningAllowance(plan.maxDriverOvertimeMin, "maxDriverOvertimeMin")),
    allowLateStopsMin: plan?.allowLateStopsMin == null
      ? policy.allowLateStopsMin
      : Math.min(policy.allowLateStopsMin, normalizePlanningAllowance(plan.allowLateStopsMin, "allowLateStopsMin")),
  };
}