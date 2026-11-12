import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ROUTE_PLANNING_OBJECTIVES, objectiveTranslationSuffix, type RoutePlanningObjective } from "@/lib/planning-objectives";
import { cn } from "@/lib/utils";

/** Progressive disclosure: summary always visible, controls on demand. */
export function OptimizerSettings({ objective, onObjective, balanceVehicles, onBalanceVehicles, locked, advanced }: {
  objective: RoutePlanningObjective;
  onObjective: (value: RoutePlanningObjective) => void;
  balanceVehicles: boolean;
  onBalanceVehicles: (value: boolean) => void;
  /** Settings apply to the next optimization only; locked once a proposal exists. */
  locked?: boolean;
  advanced?: ReactNode;
}) {
  const { t } = useTranslation();
  const objectiveLabel = t(`planner.optimizationProfile${objectiveTranslationSuffix(objective)}`);
  return (
    <details className="group rounded-lg border border-border/70 bg-card/60" data-testid="optimizer-settings">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
        <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate" data-testid="text-active-settings">
          <span className="font-semibold">{objectiveLabel}</span>
          <span className="text-muted-foreground"> · {balanceVehicles ? "Använd alla valda fordon" : "Så få fordon som möjligt"}</span>
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Inställningar</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-3 border-t border-border/60 px-3 pb-3 pt-2">
        {locked && (
          <p className="rounded bg-muted/70 px-2 py-1 text-[11px] text-muted-foreground">
            Visar inställningarna för aktuellt förslag. Ändringar gäller först nästa optimering.
          </p>
        )}
        <fieldset>
          <legend className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t("planner.optimizationGoal")}</legend>
          <RadioGroup value={objective} onValueChange={(v) => onObjective(v as RoutePlanningObjective)} className="grid grid-cols-1 gap-1">
            {ROUTE_PLANNING_OBJECTIVES.map((profile) => (
              <label key={profile} htmlFor={`optimization-profile-${profile}`}
                className={cn("flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 transition-colors",
                  objective === profile ? "border-primary/60 bg-primary/5" : "border-transparent hover:bg-muted/50")}>
                <RadioGroupItem value={profile} id={`optimization-profile-${profile}`} data-testid={`radio-objective-${profile}`} className="mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-xs font-semibold">{t(`planner.optimizationProfile${objectiveTranslationSuffix(profile)}`)}</span>
                  <span className="block text-[11px] leading-tight text-muted-foreground">{t(`planner.optimizationProfile${objectiveTranslationSuffix(profile)}Description`)}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </fieldset>
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Fördelning</p>
          <label htmlFor="balance-selected-vehicles" className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
            <Checkbox id="balance-selected-vehicles" data-testid="checkbox-balance-vehicles" checked={balanceVehicles}
              onCheckedChange={(c) => onBalanceVehicles(c === true)} className="mt-0.5" />
            <span>
              <span className="block text-xs font-semibold">{t("planner.balanceVehicles")}</span>
              <span className="block text-[11px] leading-tight text-muted-foreground">
                {balanceVehicles ? t("planner.balanceVehiclesHelp") : t("planner.minimizeVehiclesHelp")}
              </span>
            </span>
          </label>
        </div>
        {advanced && (
          <details className="group/adv rounded-md border border-dashed border-border/80">
            <summary className="flex cursor-pointer list-none items-center justify-between px-2 py-1.5 text-[11px] font-semibold text-muted-foreground [&::-webkit-details-marker]:hidden">
              Avancerat
              <ChevronDown className="h-3 w-3 transition-transform group-open/adv:rotate-180" />
            </summary>
            <div className="space-y-3 border-t border-dashed border-border/80 p-2">{advanced}</div>
          </details>
        )}
      </div>
    </details>
  );
}
