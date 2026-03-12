import { useState } from "react";
import {
  AlertTriangle,
  Lightbulb,
  Info,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Sparkles,
  Zap,
  Battery,
  Truck,
  MapPin,
  Leaf,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useInsights } from "@/hooks/use-insights";
import { useTranslation } from "react-i18next";

const typeConfig = {
  warning: {
    icon: AlertTriangle,
    label: "Warning",
    dotColor: "bg-red-500",
    bgColor: "bg-red-500/10",
    textColor: "text-red-400",
    borderColor: "border-red-500/20",
  },
  suggestion: {
    icon: Lightbulb,
    label: "Suggestion",
    dotColor: "bg-amber-500",
    bgColor: "bg-amber-500/10",
    textColor: "text-amber-400",
    borderColor: "border-amber-500/20",
  },
  info: {
    icon: Info,
    label: "Info",
    dotColor: "bg-blue-500",
    bgColor: "bg-blue-500/10",
    textColor: "text-blue-400",
    borderColor: "border-blue-500/20",
  },
};

const categoryIcons: Record<string, typeof Zap> = {
  delivery: MapPin,
  vehicle: Truck,
  planning: Zap,
  sustainability: Leaf,
  capacity: Battery,
};

export function InsightsPanel({ dashboardUpdatedAt }: { dashboardUpdatedAt?: number }) {
  const [isExpanded, setIsExpanded] = useState(true);
  const { data, isLoading, error, refetch, isFetching } = useInsights(dashboardUpdatedAt);
  const { t } = useTranslation();

  const insights = data?.insights ?? [];
  const hasInsights = insights.length > 0;

  const warningCount = insights.filter((i) => i.type === "warning").length;
  const suggestionCount = insights.filter((i) => i.type === "suggestion").length;

  return (
    <div className="bg-card rounded-2xl border border-card-border shadow-lg shadow-black/5 overflow-hidden">
      <div className="flex items-center justify-between p-5">
        <div
          role="button"
          tabIndex={0}
          onClick={() => setIsExpanded(!isExpanded)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setIsExpanded(!isExpanded); }}
          className="flex items-center gap-3 flex-1 cursor-pointer"
        >
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-violet-500/20 to-primary/20 flex items-center justify-center">
            <Sparkles className="h-5 w-5 text-violet-400" />
          </div>
          <div className="text-left">
            <h3 className="font-bold text-sm text-foreground">{t("insights.title")}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isLoading
                ? t("insights.analyzing")
                : hasInsights
                  ? t("insights.insightCount", { count: insights.length })
                  : t("insights.allClear")}
              {warningCount > 0 && (
                <span className="text-red-400 ml-1">
                  {t("insights.warningCount", { count: warningCount })}
                </span>
              )}
              {suggestionCount > 0 && (
                <span className="text-amber-400 ml-1">
                  {t("insights.suggestionCount", { count: suggestionCount })}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="h-8 w-8 rounded-lg hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
          </button>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="h-8 w-8 rounded-lg hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          >
            {isExpanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="px-5 pb-5 space-y-3">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
              <RefreshCw className="h-4 w-4 animate-spin" />
              {t("insights.analyzing")}
            </div>
          )}

          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 rounded-xl p-3 border border-red-500/20">
              {t("insights.failedToLoad")}
            </div>
          )}

          {!isLoading && !error && !hasInsights && (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <div className="h-12 w-12 rounded-full bg-emerald-500/10 flex items-center justify-center">
                <Sparkles className="h-6 w-6 text-emerald-500" />
              </div>
              <p className="text-sm font-medium text-foreground">{t("insights.allGood")}</p>
              <p className="text-xs text-muted-foreground">{t("insights.noIssues")}</p>
            </div>
          )}

          {insights.map((insight) => {
            const config = typeConfig[insight.type as keyof typeof typeConfig] ?? typeConfig.info;
            const TypeIcon = config.icon;
            const CategoryIcon = categoryIcons[insight.category] ?? Zap;

            const parts = insight.description.split("\n\n💡 ");
            const mainDesc = parts[0];
            const recommendation = parts.length > 1 ? parts[1] : null;

            return (
              <div
                key={insight.id}
                className={cn(
                  "rounded-xl p-4 border transition-colors",
                  config.bgColor,
                  config.borderColor,
                )}
              >
                <div className="flex items-start gap-3">
                  <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center flex-shrink-0", config.bgColor)}>
                    <TypeIcon className={cn("h-4 w-4", config.textColor)} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="text-sm font-semibold text-foreground">{insight.title}</h4>
                      <span className={cn("text-[10px] uppercase font-bold px-1.5 py-0.5 rounded", config.bgColor, config.textColor)}>
                        {insight.severity}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{mainDesc}</p>
                    {recommendation && (
                      <div className="mt-2 flex items-start gap-1.5 text-xs text-foreground/80 bg-background/50 rounded-lg p-2">
                        <Lightbulb className="h-3.5 w-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
                        <span>{recommendation}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 mt-2">
                      <CategoryIcon className="h-3 w-3 text-muted-foreground" />
                      <span className="text-[10px] text-muted-foreground capitalize">{insight.category}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
