import type { ScheduledStop } from "./scheduling";

export const SLA_RISK_MARGIN_MINUTES = 30;

export type StopVisualStatus =
  | "planned"
  | "in_transit"
  | "arrived"
  | "completed"
  | "failed"
  | "sla_risk";

export function getStopVisualStatus(
  stop: Pick<ScheduledStop, "status" | "timeWindowEnd" | "arrivalTime">,
  now: Date = new Date(),
): StopVisualStatus {
  const s = (stop.status ?? "").toLowerCase();
  if (s === "completed" || s === "delivered" || s === "done") return "completed";
  if (s === "failed" || s === "cancelled" || s === "canceled") return "failed";
  if (s === "arrived" || s === "on_site") return "arrived";
  if (s === "in_progress" || s === "in_transit" || s === "en_route") return "in_transit";
  if (stop.timeWindowEnd && stop.arrivalTime) {
    const end = new Date(stop.timeWindowEnd);
    const marginMin = (end.getTime() - stop.arrivalTime.getTime()) / 60000;
    if (marginMin < SLA_RISK_MARGIN_MINUTES) return "sla_risk";
    void now;
  }
  return "planned";
}

export interface StatusStyle {
  dot: string;
  ring: string;
  badge: string;
  label: string;
}

export const STATUS_STYLES: Record<StopVisualStatus, StatusStyle> = {
  planned: {
    dot: "bg-slate-400",
    ring: "",
    badge: "bg-slate-500/15 text-slate-400 border-slate-500/30",
    label: "dispatch.statusPlanned",
  },
  in_transit: {
    dot: "bg-blue-500",
    ring: "ring-2 ring-blue-400/60",
    badge: "bg-blue-500/20 text-blue-300 border-blue-500/40",
    label: "dispatch.statusInTransit",
  },
  arrived: {
    dot: "bg-cyan-400",
    ring: "ring-2 ring-cyan-300/70",
    badge: "bg-cyan-500/20 text-cyan-200 border-cyan-500/40",
    label: "dispatch.statusArrived",
  },
  completed: {
    dot: "bg-emerald-500",
    ring: "ring-2 ring-emerald-400/70",
    badge: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    label: "dispatch.statusCompleted",
  },
  failed: {
    dot: "bg-red-500",
    ring: "ring-2 ring-red-500",
    badge: "bg-red-500/20 text-red-300 border-red-500/40",
    label: "dispatch.statusFailed",
  },
  sla_risk: {
    dot: "bg-amber-500",
    ring: "ring-2 ring-amber-500",
    badge: "bg-amber-500/20 text-amber-300 border-amber-500/40",
    label: "dispatch.statusSlaRisk",
  },
};

export function slaMarginMinutes(stop: Pick<ScheduledStop, "timeWindowEnd" | "arrivalTime">): number | null {
  if (!stop.timeWindowEnd || !stop.arrivalTime) return null;
  return (new Date(stop.timeWindowEnd).getTime() - stop.arrivalTime.getTime()) / 60000;
}

export function extractPostcodePrefix(address: string): string {
  const m = address.match(/\b(\d{3})\s?\d{2}\b/);
  return m ? `${m[1]}xx` : "—";
}
