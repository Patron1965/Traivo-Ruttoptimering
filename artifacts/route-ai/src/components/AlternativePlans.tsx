import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Loader2, Leaf, Zap, Scale, CheckCircle2, Truck, MapPin, Clock, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { localizeError } from "@/lib/localize-error";

interface AlternativePlan {
  name: string;
  weights: {
    distanceWeight: number;
    co2Weight: number;
    etaPrecisionWeight: number;
    driverHappinessWeight: number;
  };
  cost: number;
  vehicleCount: number;
  stopCount: number;
  unassignedCount: number;
  totalDistanceKm: number;
  totalCo2Kg: number;
  totalDurationMin: number;
  routes: {
    vehicleId: string;
    stopCount: number;
    stops: { id: string; latitude: number; longitude: number }[];
  }[];
}

interface AlternativePlansProps {
  organizationId: string;
  vehicleIds: string[];
  stopIds: string[];
  depotLatitude: number;
  depotLongitude: number;
  onSelectPlan: (plan: AlternativePlan) => void;
  disabled?: boolean;
}

const PROFILE_ICONS: Record<string, typeof Zap> = {
  fastest: Zap,
  greenest: Leaf,
  balanced: Scale,
};

const PROFILE_COLORS: Record<string, string> = {
  fastest: "border-blue-500/50 bg-blue-500/5",
  greenest: "border-green-500/50 bg-green-500/5",
  balanced: "border-purple-500/50 bg-purple-500/5",
};

const PROFILE_ACCENT: Record<string, string> = {
  fastest: "text-blue-500",
  greenest: "text-green-500",
  balanced: "text-purple-500",
};

export function AlternativePlans({
  organizationId,
  vehicleIds,
  stopIds,
  depotLatitude,
  depotLongitude,
  onSelectPlan,
  disabled,
}: AlternativePlansProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [plans, setPlans] = useState<AlternativePlan[] | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setPlans(null);
    setSelectedIdx(null);

    try {
      const res = await fetch("/api/optimize/alternatives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          vehicleIds,
          stopIds,
          depotLatitude,
          depotLongitude,
          timeBudgetMs: 30000,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const error = new Error(data?.error || "Failed to generate alternatives");
        Object.assign(error, { status: res.status, data });
        throw error;
      }

      const data = await res.json();
      setPlans(data.alternatives);
    } catch (err) {
      setError(localizeError(err, t, { fallbackKey: "planner.alternativesFailed" }));
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (idx: number) => {
    setSelectedIdx(idx);
    if (plans) {
      onSelectPlan(plans[idx]);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("planner.generatingAlternatives")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-destructive py-2">
        {error}
        <Button variant="ghost" size="sm" onClick={handleGenerate} className="ml-2">
          {t("planner.compareAlternatives")}
        </Button>
      </div>
    );
  }

  if (!plans) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={handleGenerate}
        disabled={disabled || vehicleIds.length === 0 || stopIds.length === 0}
        className="gap-2"
      >
        <Scale className="h-4 w-4" />
        {t("planner.compareAlternatives")}
      </Button>
    );
  }

  const bestDistance = Math.min(...plans.map(p => p.totalDistanceKm));
  const bestCo2 = Math.min(...plans.map(p => p.totalCo2Kg));
  const bestDuration = Math.min(...plans.map(p => p.totalDurationMin));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          {t("planner.alternativePlans")}
        </h3>
        <Button variant="ghost" size="sm" onClick={handleGenerate} className="text-xs">
          {t("planner.compareAlternatives")}
        </Button>
      </div>

      <div className="grid gap-3">
        {plans.map((plan, idx) => {
          const Icon = PROFILE_ICONS[plan.name] || Scale;
          const isSelected = selectedIdx === idx;
          const colorClass = PROFILE_COLORS[plan.name] || "";
          const accentClass = PROFILE_ACCENT[plan.name] || "text-primary";

          return (
            <button
              key={plan.name}
              onClick={() => handleSelect(idx)}
              className={cn(
                "relative w-full rounded-lg border-2 p-4 text-left transition-all hover:shadow-md",
                colorClass,
                isSelected && "ring-2 ring-primary shadow-lg"
              )}
            >
              {isSelected && (
                <div className="absolute top-2 right-2">
                  <CheckCircle2 className="h-5 w-5 text-primary" />
                </div>
              )}

              <div className="flex items-center gap-2 mb-3">
                <Icon className={cn("h-5 w-5", accentClass)} />
                <span className="font-semibold text-sm">
                  {t(`planner.${plan.name}`)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t(`planner.${plan.name}Desc`)}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <div className="flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">{t("planner.totalDistance")}:</span>
                  <span className={cn("font-medium", plan.totalDistanceKm === bestDistance && "text-green-600")}>
                    {plan.totalDistanceKm.toFixed(1)} km
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <Leaf className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">{t("planner.totalCo2")}:</span>
                  <span className={cn("font-medium", plan.totalCo2Kg === bestCo2 && "text-green-600")}>
                    {plan.totalCo2Kg.toFixed(1)} kg
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">{t("planner.totalDuration")}:</span>
                  <span className={cn("font-medium", plan.totalDurationMin === bestDuration && "text-green-600")}>
                    {Math.round(plan.totalDurationMin)} min
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <Truck className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">{t("planner.vehiclesUsed")}:</span>
                  <span className="font-medium">{plan.vehicleCount}</span>
                </div>

                <div className="flex items-center gap-1.5">
                  <BarChart3 className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">{t("planner.costScore")}:</span>
                  <span className="font-medium">{plan.cost}</span>
                </div>

                {plan.unassignedCount > 0 && (
                  <div className="flex items-center gap-1.5 text-amber-600">
                    <span>{t("planner.unassigned")}: {plan.unassignedCount}</span>
                  </div>
                )}
              </div>

              {!isSelected && (
                <div className="mt-3 text-center">
                  <span className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    {t("planner.selectPlan")}
                  </span>
                </div>
              )}

              {isSelected && (
                <div className="mt-3 text-center">
                  <span className="text-xs text-primary font-medium">
                    {t("planner.selectedPlan")}
                  </span>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
