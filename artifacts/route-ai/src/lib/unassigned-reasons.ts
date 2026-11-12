export interface UnassignedReasonPresentation {
  code: string;
  label: string;
  detail: string | null;
}

/**
 * Reason-code labels are the stable, localized explanation. Optimizer details
 * add evidence below that label, but must never replace it or turn a missing
 * detail into an instruction to recalculate an already completed run.
 */
export function getUnassignedReasonPresentation(
  reasonCode: string | null | undefined,
  localizedLabel: string | null | undefined,
  detail: string | null | undefined,
  genericLabel: string,
): UnassignedReasonPresentation {
  const code = reasonCode?.trim().toUpperCase() || "UNASSIGNED";
  return {
    code,
    label: localizedLabel?.trim() || genericLabel,
    detail: detail?.trim() || null,
  };
}