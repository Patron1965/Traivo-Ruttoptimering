export interface UnplannedStopDiagnosticPresentation {
  exact: boolean;
  sourceLabelKey: string;
  recommendationKey: string;
}

const EXACT_DIAGNOSTIC_PRESENTATION: Record<
  string,
  Omit<UnplannedStopDiagnosticPresentation, "exact">
> = {
  FIELD_SERVICE_INELIGIBLE: {
    sourceLabelKey: "import.unplannedDiagnosticFieldService",
    recommendationKey: "import.unplannedRecommendationFieldService",
  },
  CAPACITY_EXCEEDED: {
    sourceLabelKey: "import.unplannedDiagnosticCapacity",
    recommendationKey: "import.unplannedRecommendationCapacity",
  },
  RANGE_EXCEEDED: {
    sourceLabelKey: "import.unplannedDiagnosticRange",
    recommendationKey: "import.unplannedRecommendationRange",
  },
  TIME_WINDOW_UNREACHABLE: {
    sourceLabelKey: "import.unplannedDiagnosticTimeWindow",
    recommendationKey: "import.unplannedRecommendationTimeWindow",
  },
  LATE_TOLERANCE_EXCEEDED: {
    sourceLabelKey: "import.unplannedDiagnosticLateTolerance",
    recommendationKey: "import.unplannedRecommendationLateTolerance",
  },
  OVERTIME_ALLOWANCE_EXCEEDED: {
    sourceLabelKey: "import.unplannedDiagnosticOvertime",
    recommendationKey: "import.unplannedRecommendationOvertime",
  },
  BREAK_WINDOW_CONFLICT: {
    sourceLabelKey: "import.unplannedDiagnosticBreakWindow",
    recommendationKey: "import.unplannedRecommendationBreakWindow",
  },
  STOP_AVAILABILITY_CONFLICT: {
    sourceLabelKey: "import.unplannedDiagnosticAvailability",
    recommendationKey: "import.unplannedRecommendationAvailability",
  },
};

export function unplannedStopDiagnosticPresentation(
  code?: string | null,
): UnplannedStopDiagnosticPresentation {
  const presentation = code ? EXACT_DIAGNOSTIC_PRESENTATION[code] : undefined;
  if (presentation) return { exact: true, ...presentation };
  return {
    exact: false,
    sourceLabelKey: "import.unplannedDiagnosticFallbackLabel",
    recommendationKey: "import.unplannedRecommendationFallback",
  };
}