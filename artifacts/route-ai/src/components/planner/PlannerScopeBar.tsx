import { Search, X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { NO_VALUE, type PlannerScope, type ResolvedScope } from "@/lib/planner-workflow";

const ALL_AREAS = "__all__";

function ScopeSelect({ label, value, placeholder, options, onChange, testId, needsChoice, renderLabel }: {
  label: string;
  value: string | null;
  placeholder: string;
  options: { value: string; count: number }[];
  onChange: (value: string) => void;
  testId: string;
  needsChoice?: boolean;
  renderLabel: (value: string) => string;
}) {
  return (
    <label className="flex min-w-0 items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <Select value={value ?? ""} onValueChange={onChange} disabled={options.length === 0}>
        <SelectTrigger
          data-testid={testId}
          className={cn(
            "h-7 min-w-[7.5rem] max-w-[14rem] gap-1 border-border/70 bg-card px-2 text-xs",
            needsChoice && "border-amber-500/70 ring-1 ring-amber-500/30",
          )}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {renderLabel(o.value)} <span className="ml-1 font-mono text-muted-foreground">{o.count}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

export function PlannerScopeBar({ scope, resolved, projectLabel, onChange }: {
  scope: PlannerScope;
  resolved: ResolvedScope;
  projectLabel: (value: string) => string;
  onChange: (next: PlannerScope) => void;
}) {
  const dateLabel = (v: string) => v === NO_VALUE ? "Utan datum" : new Date(`${v}T12:00:00`).toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short" });
  const areaLabel = (v: string) => v === ALL_AREAS ? "Alla områden" : v === NO_VALUE ? "Utan postnummer" : v;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="planner-scope-bar">
      <ScopeSelect
        label="Projekt" value={resolved.project} placeholder="Välj projekt" testId="select-scope-project"
        options={resolved.projects} needsChoice={resolved.needs === "project"} renderLabel={projectLabel}
        onChange={(project) => onChange({ ...scope, project, date: null, area: null })}
      />
      <ScopeSelect
        label="Dag" value={resolved.date} placeholder={resolved.project ? "Välj dag" : "–"} testId="select-scope-date"
        options={resolved.dates} needsChoice={resolved.needs === "date"} renderLabel={dateLabel}
        onChange={(date) => onChange({ ...scope, date, area: null })}
      />
      <ScopeSelect
        label="Område" value={scope.area ?? ALL_AREAS} placeholder="Alla områden" testId="select-scope-area"
        options={resolved.date ? [{ value: ALL_AREAS, count: resolved.areas.reduce((n, a) => n + a.count, 0) }, ...resolved.areas] : []}
        renderLabel={areaLabel}
        onChange={(area) => onChange({ ...scope, area: area === ALL_AREAS ? null : area })}
      />
      <div className="relative min-w-[10rem] flex-1 sm:max-w-[16rem]">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          data-testid="input-scope-search"
          value={scope.search}
          onChange={(e) => onChange({ ...scope, search: e.target.value })}
          placeholder="Sök kund, adress, referens"
          className="h-7 w-full rounded-md border border-border/70 bg-card pl-7 pr-6 text-xs placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
        {scope.search && (
          <button type="button" aria-label="Rensa sökning" data-testid="button-clear-search"
            onClick={() => onChange({ ...scope, search: "" })}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
