export type RouteAdjustmentAction = "adjust" | "open" | "blocked";

export type RouteAdjustmentResult<T> =
  | { kind: "adjustment-failed"; error: unknown }
  | { kind: "open-failed"; result: T; error: unknown }
  | { kind: "opened"; result: T }
  | { kind: "blocked" };

export function routeAdjustmentAction(input: {
  hasValidatedResult: boolean;
  /** Routes loaded from the server already are a persisted working plan. */
  hasPersistedPlan?: boolean;
  isDirty: boolean;
  planningInputsMatch: boolean;
  sharedInstructionsMatch: boolean;
}): RouteAdjustmentAction {
  if (!input.planningInputsMatch || !input.sharedInstructionsMatch) {
    return "blocked";
  }
  return (input.hasValidatedResult || input.hasPersistedPlan) && !input.isDirty ? "open" : "adjust";
}

/**
 * Models the side-effect boundary so the retry behavior stays testable:
 * protected-input drift blocks both calls, while an open failure retains the
 * mutation result and can be retried without invoking adjust again.
 */
export async function runRouteAdjustment<T>(input: {
  action: RouteAdjustmentAction;
  validatedResult?: T;
  adjust: () => Promise<T>;
  open: (result: T) => Promise<void>;
}): Promise<RouteAdjustmentResult<T>> {
  if (input.action === "blocked") return { kind: "blocked" };
  if (input.action === "open" && input.validatedResult !== undefined) {
    try {
      await input.open(input.validatedResult);
      return { kind: "opened", result: input.validatedResult };
    } catch (error) {
      return { kind: "open-failed", result: input.validatedResult, error };
    }
  }
  try {
    const result = await input.adjust();
    try {
      await input.open(result);
      return { kind: "opened", result };
    } catch (error) {
      return { kind: "open-failed", result, error };
    }
  } catch (error) {
    return { kind: "adjustment-failed", error };
  }
}
