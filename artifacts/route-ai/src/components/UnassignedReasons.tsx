import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getUnassignedReasonPresentation } from "@/lib/unassigned-reasons";

interface UnassignedReason {
  stopId: string;
  reasonCodes: string[];
  details: string[];
}

export function UnassignedReasonsList({ reasons }: { reasons: UnassignedReason[] }) {
  const { t } = useTranslation();
  if (!reasons?.length) return null;

  return (
    <div className="mt-3 space-y-2 max-h-48 overflow-y-auto pr-2" data-testid="unassigned-reasons-list">
      {reasons.map((r, i) => (
        <div key={`${r.stopId}-${i}`} className="bg-destructive/10 text-destructive-foreground p-3 rounded-lg border border-destructive/20 text-sm" data-testid={`unassigned-reason-${r.stopId}`}>
          <p className="font-semibold text-destructive mb-1 flex items-center gap-1.5">
            <AlertCircle className="h-4 w-4" /> {t("planner.unassigned.assignmentLabel")}: {r.stopId.split("-").pop()}
          </p>
          <ul className="space-y-1 pl-5 list-disc text-xs text-destructive/90">
            {r.reasonCodes.map((code: string, idx: number) => {
              const detail = r.details?.[idx]?.trim();
              const genericLabel = t("planner.unassigned.UNASSIGNED");
              const presentation = getUnassignedReasonPresentation(
                code,
                t(
                  `planner.unassigned.${code.trim().toUpperCase() || "UNASSIGNED"}`,
                  { defaultValue: genericLabel },
                ),
                detail,
                genericLabel,
              );
              return (
                <li key={`${code}-${idx}`}>
                  <span className="font-semibold">{presentation.label}</span>
                  {presentation.detail && (
                    <span className="block mt-0.5 text-destructive/75">
                      {presentation.detail}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
