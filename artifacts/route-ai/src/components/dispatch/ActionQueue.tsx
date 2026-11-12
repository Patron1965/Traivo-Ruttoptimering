import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ScheduledRow, ScheduledStop } from "@/lib/scheduling";
import { slaMarginMinutes, SLA_RISK_MARGIN_MINUTES } from "@/lib/dispatch-status";
import type { Stop } from "@workspace/api-client-react";
import {
  AlertTriangle,
  Clock,
  PackageX,
  Timer,
  ChevronRight,
  X,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type ActionSection =
  | "overloaded"
  | "missingResources"
  | "sla"
  | "lateFinish"
  | "unplannedTw"
  | "failed";

const ActionGuidance = createContext("");
const guidance: Record<ActionSection, string> = {
  overloaded: "Granska och flytta uppdrag. Avvikelsen kräver behörig bekräftelse; annars måste kapaciteten rättas före utskick.",
  missingResources: "Blockerar utskick. Öppna rutten och välj en tillgänglig resurs.",
  sla: "Öppna uppdraget och granska tidsfönstret. Liten marginal är en risk; brutet hårt tidsfönster blockerar ändringen.",
  lateFinish: "Granska rutten och flytta uppdrag eller bekräfta en tillåten arbetstidsavvikelse. Slutlig utskickskontroll krävs.",
  unplannedTw: "Öppna uppdraget och föreslå resurs. Ej tilldelat är inte automatiskt fel, men uppdraget skickas inte till förare.",
  failed: "Öppna uppdragets utförande och granska orsaken. Historiken får inte skrivas om; detta är inte i sig en ny utskicksspärr.",
};

interface ActionQueueProps {
  rows: ScheduledRow[];
  unassignedStops: Stop[];
  focusSection?: ActionSection | null;
  onSelectStop: (stopId: string, rowIndex: number) => void;
  onHighlightRoute: (routeId: string) => void;
  onFocusUnassigned?: (stopId: string) => void;
  onClose?: () => void;
}

function formatHm(d: Date | undefined) {
  return d
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";
}

function formatMargin(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(minutes);
  if (abs < 60) return `${sign}${Math.round(abs)}m`;
  if (abs < 1440) return `${sign}${Math.round(abs / 60)}h`;
  const days = Math.round(abs / 1440);
  return `${sign}${days}d`;
}

export function ActionQueue({
  rows,
  unassignedStops,
  focusSection,
  onSelectStop,
  onHighlightRoute,
  onFocusUnassigned,
  onClose,
}: ActionQueueProps) {
  const { t } = useTranslation();

  const routeRows = useMemo(
    () => rows.filter((r) => r.routeId !== "unplanned"),
    [rows],
  );

  const overloaded = useMemo(
    () =>
      routeRows
        .filter((r) => r.capacityKg > 0 && r.capacityPercent > 100)
        .sort((a, b) => b.capacityPercent - a.capacityPercent),
    [routeRows],
  );

  const missingResources = useMemo(
    () => routeRows.filter((row) => !row.vehicleId || !row.driverId),
    [routeRows],
  );

  const slaRisk = useMemo(() => {
    const items: Array<{
      stop: ScheduledStop;
      row: ScheduledRow;
      rowIdx: number;
      margin: number;
      serverLate: boolean;
    }> = [];
    rows.forEach((row, rowIdx) => {
      // Do not turn locally estimated stop times into an operational SLA
      // warning. The server timeline is the only schedulable evidence.
      if (row.routeId === "unplanned" || row.workdayStatus !== "authoritative") return;
      row.stops.forEach((stop) => {
        const m = slaMarginMinutes(stop);
        const serverLate = row.summary?.lateStopIds?.includes(stop.stopId) ?? false;
        if (serverLate || (m !== null && m < SLA_RISK_MARGIN_MINUTES)) {
          items.push({ stop, row, rowIdx, margin: m ?? -1, serverLate });
        }
      });
    });
    return items.sort((a, b) => a.margin - b.margin);
  }, [rows]);

  const failed = useMemo(() => {
    const items: Array<{
      stop: ScheduledStop;
      row: ScheduledRow;
      rowIdx: number;
    }> = [];
    rows.forEach((row, rowIdx) => {
      if (row.routeId === "unplanned") return;
      row.stops.forEach((stop) => {
        const s = (stop.status ?? "").toLowerCase();
        if (s === "failed" || s === "cancelled" || s === "canceled") {
          items.push({ stop, row, rowIdx });
        }
      });
    });
    return items;
  }, [rows]);

  const lateFinish = useMemo(() => {
    const items: Array<{ row: ScheduledRow; endTime: Date }> = [];
    routeRows.forEach((row) => {
      if (row.workdayStatus !== "authoritative") return;
      const lastTimelineEvent = row.timeline?.[row.timeline.length - 1];
      if (!lastTimelineEvent) return;
      const end = new Date(lastTimelineEvent.endAt);
      if (!Number.isFinite(end.getTime())) return;
      // Prefer the server's actual overtime calculation. A local clock cutoff
      // would turn a valid late shift into a false warning.
      const overtime = row.summary?.overtimeMin ?? 0;
      if (overtime > 0) {
        items.push({ row, endTime: end });
      }
    });
    return items.sort((a, b) => b.endTime.getTime() - a.endTime.getTime());
  }, [routeRows]);

  const unplannedTw = useMemo(() => {
    const now = Date.now();
    return unassignedStops
      .map((s) => ({
        stop: s,
        endMs: s.timeWindowEnd ? new Date(s.timeWindowEnd).getTime() : Number.POSITIVE_INFINITY,
      }))
      .filter((x) => !Number.isNaN(x.endMs))
      .sort((a, b) => a.endMs - b.endMs)
      .map((x) => ({
        ...x,
        overdue: x.endMs < now,
      }));
  }, [unassignedStops]);

  const totalCount =
    overloaded.length +
    missingResources.length +
    slaRisk.length +
    failed.length +
    lateFinish.length +
    unplannedTw.length;

  return (
    <aside className="w-[300px] shrink-0 border-l border-border bg-card/60 backdrop-blur-sm flex flex-col h-full">
      <div className="shrink-0 px-3 py-2 border-b border-border/70 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-500" />
        <h2 className="text-[13px] font-bold flex-1">
          {t("dispatch.actionQueue")}
        </h2>
        <span className="text-[10px] tabular-nums font-semibold px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
          {totalCount}
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer"
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {totalCount === 0 && (
          <div className="p-6 text-center text-xs text-muted-foreground">
            <div className="mx-auto w-10 h-10 rounded-full bg-emerald-500/15 flex items-center justify-center mb-2">
              <svg
                className="w-5 h-5 text-emerald-500"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <p className="font-semibold text-foreground mb-0.5">
              {t("dispatch.actionQueueCleanTitle")}
            </p>
            <p>{t("dispatch.actionQueueCleanDesc")}</p>
          </div>
        )}

        {overloaded.length > 0 && (
          <Section
            id="overloaded"
            icon={<AlertTriangle className="h-3.5 w-3.5" />}
            tone="destructive"
            title={t("dispatch.overloaded")}
            count={overloaded.length}
            highlight={focusSection === "overloaded"}
          >
            {overloaded.map((row) => (
              <ActionItem
                key={row.routeId}
                onClick={() => onHighlightRoute(row.routeId)}
                color={row.color}
                primary={row.routeName}
                secondary={row.driverName}
                rightLabel={`${Math.round(row.capacityPercent)}%`}
                rightTone="destructive"
              />
            ))}
          </Section>
        )}

        {missingResources.length > 0 && (
          <Section
            id="missingResources"
            icon={<AlertTriangle className="h-3.5 w-3.5" />}
            tone="destructive"
            title={t("dispatch.missingResources", "Saknar resurser")}
            count={missingResources.length}
            highlight={focusSection === "missingResources"}
          >
            {missingResources.map((row) => (
              <ActionItem
                key={row.routeId}
                onClick={() => onHighlightRoute(row.routeId)}
                color={row.color}
                primary={row.routeName}
                secondary={row.driverId ? t("dispatch.noVehicle") : t("dispatch.unassigned")}
                rightLabel={t("dispatch.fixResource", "Åtgärda")}
                rightTone="destructive"
              />
            ))}
          </Section>
        )}

        {failed.length > 0 && (
          <Section
            id="failed"
            icon={<PackageX className="h-3.5 w-3.5" />}
            tone="destructive"
            title={t("dispatch.failedStops")}
            count={failed.length}
            highlight={focusSection === "failed"}
          >
            {failed.map(({ stop, row, rowIdx }) => (
              <ActionItem
                key={stop.stopId}
                onClick={() => {
                  onHighlightRoute(row.routeId);
                  onSelectStop(stop.stopId, rowIdx);
                }}
                color={row.color}
                primary={stop.address}
                secondary={row.routeName}
                rightLabel={t("dispatch.statusFailed")}
                rightTone="destructive"
              />
            ))}
          </Section>
        )}

        {slaRisk.length > 0 && (
          <Section
            id="sla"
            icon={<Clock className="h-3.5 w-3.5" />}
            tone="amber"
            title={t("dispatch.slaRisk")}
            count={slaRisk.length}
            highlight={focusSection === "sla"}
          >
            <div className="mb-2 rounded-md border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-relaxed text-muted-foreground">
              <p>{t("dispatch.slaRiskExplanation")}</p>
              <p className="mt-2">{t("dispatch.slaRiskExample")}</p>
              <p className="mt-2">{t("dispatch.slaRiskGuidance")}</p>
            </div>
            {slaRisk.slice(0, 20).map(({ stop, row, rowIdx, margin, serverLate }) => (
              <ActionItem
                key={stop.stopId}
                onClick={() => {
                  onHighlightRoute(row.routeId);
                  onSelectStop(stop.stopId, rowIdx);
                }}
                color={row.color}
                primary={stop.address}
                 secondary={`${row.routeName} · ${t("dispatch.etaShort")} ${formatHm(stop.arrivalTime)}`}
                 rightLabel={serverLate
                   ? t("dispatch.lateArrival", "Sen ankomst")
                   : formatMargin(margin)}
                 rightTone={serverLate || margin < 0 ? "destructive" : "amber"}
              />
            ))}
            {slaRisk.length > 20 && (
              <div className="px-3 py-1.5 text-[10px] text-muted-foreground italic">
                {t("dispatch.andMore", { count: slaRisk.length - 20 })}
              </div>
            )}
          </Section>
        )}

        {lateFinish.length > 0 && (
          <Section
            id="lateFinish"
            icon={<Timer className="h-3.5 w-3.5" />}
            tone="amber"
            title={t("dispatch.lateFinish")}
            count={lateFinish.length}
            highlight={focusSection === "lateFinish"}
          >
            {lateFinish.map(({ row, endTime }) => (
              <ActionItem
                key={row.routeId}
                onClick={() => onHighlightRoute(row.routeId)}
                color={row.color}
                primary={row.routeName}
                secondary={row.driverName}
                rightLabel={formatHm(endTime)}
                rightTone="amber"
              />
            ))}
          </Section>
        )}

        {unplannedTw.length > 0 && (
          <Section
            id="unplannedTw"
            icon={<PackageX className="h-3.5 w-3.5" />}
            tone="slate"
            title={t("dispatch.unplannedWithTw")}
            count={unplannedTw.length}
            highlight={focusSection === "unplannedTw"}
          >
            {unplannedTw.slice(0, 15).map(({ stop, overdue }) => (
              <ActionItem
                key={stop.id}
                onClick={() => onFocusUnassigned?.(stop.id)}
                color="#64748B"
                primary={stop.address}
                 secondary={
                   stop.timeWindowEnd
                     ? `${t("dispatch.twEnd")} ${formatHm(new Date(stop.timeWindowEnd))}`
                     : t("dispatch.unplannedLabel")
                 }
                 rightLabel={!stop.timeWindowEnd
                   ? t("dispatch.unplannedLabel")
                   : overdue
                     ? t("dispatch.overdue")
                     : t("dispatch.upcoming")}
                rightTone={overdue ? "destructive" : "slate"}
              />
            ))}
            {unplannedTw.length > 15 && (
              <div className="px-3 py-1.5 text-[10px] text-muted-foreground italic">
                {t("dispatch.andMore", { count: unplannedTw.length - 15 })}
              </div>
            )}
          </Section>
        )}
      </div>
    </aside>
  );
}

interface SectionProps {
  id: string;
  icon: React.ReactNode;
  tone: "destructive" | "amber" | "slate";
  title: string;
  count: number;
  highlight?: boolean;
  children: React.ReactNode;
}

function Section({ id, icon, tone, title, count, highlight, children }: SectionProps) {
  const toneClasses = {
    destructive: "text-destructive bg-destructive/10 border-destructive/30",
    amber: "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30",
    slate: "text-slate-600 dark:text-slate-300 bg-slate-500/10 border-slate-500/30",
  } as const;

  return (
    <section
      id={`aq-${id}`}
      className={cn(
        "border-b border-border/60 transition-colors",
        highlight && "bg-primary/5",
      )}
    >
      <header
        className={cn(
          "px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide flex items-center gap-1.5 border-l-2",
          toneClasses[tone],
        )}
      >
        {icon}
        <span className="flex-1">{title}</span>
        <span className="tabular-nums font-bold">{count}</span>
      </header>
      <ActionGuidance.Provider value={guidance[id as ActionSection] ?? ""}>
        <div className="py-1">{children}</div>
      </ActionGuidance.Provider>
    </section>
  );
}

interface ActionItemProps {
  onClick: () => void;
  color: string;
  primary: string;
  secondary?: string;
  rightLabel?: string;
  rightTone?: "destructive" | "amber" | "slate";
}

function ActionItem({
  onClick,
  color,
  primary,
  secondary,
  rightLabel,
  rightTone = "slate",
}: ActionItemProps) {
  const nextAction = useContext(ActionGuidance);
  const toneClasses = {
    destructive: "bg-destructive/15 text-destructive border-destructive/30",
    amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
    slate: "bg-muted text-muted-foreground border-border",
  } as const;

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-muted/60 transition-colors cursor-pointer group"
    >
      <span
        className="w-2.5 h-2.5 rounded-full shrink-0"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-semibold truncate leading-tight">
          {primary}
        </span>
        {secondary && (
          <span className="block text-[10px] text-muted-foreground truncate leading-tight">
            {secondary}
          </span>
        )}
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">{nextAction}</p>
      </span>
      {rightLabel && (
        <span
          className={cn(
            "text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded border",
            toneClasses[rightTone],
          )}
        >
          {rightLabel}
        </span>
      )}
      <ChevronRight className="h-3 w-3 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0" />
    </button>
  );
}
