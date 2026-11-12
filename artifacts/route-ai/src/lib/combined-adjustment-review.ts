import type { RouteAdjustmentInput, RouteAdjustmentPreview } from "@workspace/api-client-react";

/** Preserve the entire membership/order/pair/revision draft, not a resource-only subset. */
export function captureAdjustmentDraft(input: RouteAdjustmentInput): RouteAdjustmentInput {
  const clone = JSON.parse(JSON.stringify(input)) as RouteAdjustmentInput;
  for (const route of clone.routes) {
    Object.freeze(route.stopIds);
    if (route.plannerItinerary) {
      route.plannerItinerary.forEach(entry => Object.freeze(entry));
      Object.freeze(route.plannerItinerary);
    }
    Object.freeze(route);
  }
  Object.freeze(clone.routes);
  return Object.freeze(clone);
}
export function sameAdjustmentDraft(left: RouteAdjustmentInput, right: RouteAdjustmentInput) {
  return JSON.stringify(left) === JSON.stringify(right);
}
export function boundAdjustmentConfirmation(
  captured: RouteAdjustmentInput, current: RouteAdjustmentInput,
  preview: RouteAdjustmentPreview, reviewed: boolean,
) {
  return reviewed && preview.canApply && preview.previewDigest && sameAdjustmentDraft(captured, current)
    ? Object.freeze({ ...captured, expectedPreviewDigest: preview.previewDigest }) : null;
}
