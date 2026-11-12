import { Columns2, Map as MapIcon, GanttChart } from "lucide-react";
import type { TrafficLayout } from "@/lib/live-telemetry";

const OPTIONS: Array<{ value: TrafficLayout; label: string; icon: typeof MapIcon }> = [
  { value: "map", label: "Karta", icon: MapIcon },
  { value: "split", label: "Delad", icon: Columns2 },
  { value: "timeline", label: "Tidslinje", icon: GanttChart },
];

export function TrafficLayoutSwitch({ value, onChange }: { value: TrafficLayout; onChange: (layout: TrafficLayout) => void }) {
  return (
    <div role="radiogroup" aria-label="Vy i trafikledningen" className="flex items-center rounded-md bg-muted/60 p-0.5" data-testid="traffic-layout-switch">
      {OPTIONS.map(({ value: option, label, icon: Icon }) => (
        <button key={option} type="button" role="radio" aria-checked={value === option}
          data-testid={`button-layout-${option}`} onClick={() => onChange(option)} title={label}
          className={`flex min-h-[44px] items-center gap-1 rounded px-2 text-[11px] font-semibold transition-colors sm:min-h-[32px] ${value === option ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
          <Icon className="h-3.5 w-3.5" /><span className="hidden md:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}
