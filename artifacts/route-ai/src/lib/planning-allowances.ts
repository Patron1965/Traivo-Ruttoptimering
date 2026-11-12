export type PlanningAllowances = {
  maxDriverOvertimeMin?: number;
  allowLateStopsMin?: number;
};

export function effectivePlanningAllowances(inputs?: PlanningAllowances, defaults?: PlanningAllowances): PlanningAllowances {
  const capped = (requested: number | undefined, ceiling: number | undefined) => {
    // Zero is safe even without a loaded organization ceiling. A positive
    // request is not evidence of the currently permitted effective allowance.
    if (requested === 0) return 0;
    if (ceiling == null || !Number.isInteger(ceiling) || ceiling < 0 || ceiling > 1440) return undefined;
    if (requested == null) return ceiling;
    if (!Number.isInteger(requested) || requested < 0 || requested > 1440) return undefined;
    return Math.min(requested, ceiling);
  };
  return {
    maxDriverOvertimeMin: capped(inputs?.maxDriverOvertimeMin, defaults?.maxDriverOvertimeMin),
    allowLateStopsMin: capped(inputs?.allowLateStopsMin, defaults?.allowLateStopsMin),
  };
}

/** Historical evidence must not be rewritten with today's organization caps. */
export function savedPlanningAllowances(inputs?: PlanningAllowances): PlanningAllowances {
  return {
    maxDriverOvertimeMin: inputs?.maxDriverOvertimeMin,
    allowLateStopsMin: inputs?.allowLateStopsMin,
  };
}

export function planningAllowanceText(inputs: PlanningAllowances): string {
  const minutes = (value: number | undefined) => value == null
    ? "inte tillgängligt – kontrollera inställningarna"
    : value === 0 ? "0 min (inga undantag)" : `${value} min`;
  return `Tillåten övertid per förare: ${minutes(inputs.maxDriverOvertimeMin)}. Tillåten försening vid stopp: ${minutes(inputs.allowLateStopsMin)}.`;
}

export function planningAllowancesKnown(inputs: PlanningAllowances): boolean {
  return [inputs.maxDriverOvertimeMin, inputs.allowLateStopsMin].every(
    value => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1440,
  );
}
