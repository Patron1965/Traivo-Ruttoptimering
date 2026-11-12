import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { effectivePlanningAllowances, savedPlanningAllowances, planningAllowanceText, type PlanningAllowances } from "@/lib/planning-allowances";
import { Input } from "@/components/ui/input";

export function usePlanningAllowanceDefaults() {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  return useQuery<PlanningAllowances>({
    queryKey: ["/api/org-settings", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const response = await fetch(`${import.meta.env.VITE_API_URL || ""}/api/organizations/${organizationId}/settings?organizationId=${organizationId}`, { credentials: "include" });
      if (!response.ok) throw new Error("Planeringsgränserna kunde inte hämtas.");
      return response.json();
    },
  });
}

export function PlanningAllowanceSettings({ inputs, defaults, onChange, loadFailed = false, historical = false, title = "Tillåtna undantag för arbetstid och tidsfönster" }: {
  inputs?: PlanningAllowances;
  defaults?: PlanningAllowances;
  onChange?: (patch: PlanningAllowances) => void;
  loadFailed?: boolean;
  title?: string;
  historical?: boolean;
}) {
  const effective = historical ? savedPlanningAllowances(inputs) : effectivePlanningAllowances(inputs, loadFailed ? undefined : defaults);
  return <section className="space-y-3 rounded-lg border p-4" aria-label="Tillåtna planeringsundantag">
    <h3 className="font-semibold">{title}</h3>
    <p className="text-sm" data-testid="effective-planning-allowances">{planningAllowanceText(effective)}</p>
    <p className="text-xs text-muted-foreground">{historical
      ? "Detta är den sparade planens historiska gränser, inte ett löfte om nästa beräkning. Skärpta företagsgränser kan minska tillåten övertid och försening vid nästa beräkning eller validering."
      : "Detta är effektiva gränser för nästa beräkning, även med målet Balanserad: det lägsta av planens önskade gräns och företagets aktuella tak används. Skärpta företagsgränser kan alltså minska planens tillåtna undantag."} 0 betyder inga undantag. {onChange ? "Ändra önskade gränser här för denna plan." : "Planens gränser ändras i planeringsinställningarna när redigering är tillgänglig."} Företagets tak ändras i Inställningar → Optimering.</p>
    {!historical && <p className="text-xs text-muted-foreground">Företagets aktuella tak: {planningAllowanceText(loadFailed ? {} : defaults ?? {})}</p>}
    {loadFailed && !historical && <p role="alert" className="text-sm text-destructive">Företagets gränser kunde inte hämtas. Effektiva positiva undantag är okända tills taket har hämtats; uttrycklig noll är fortfarande säker.</p>}
    {onChange && !historical && <div className="grid gap-3 sm:grid-cols-2">
      {([
        ["maxDriverOvertimeMin", "Tillåten övertid per förare (min)"],
        ["allowLateStopsMin", "Tillåten försening vid stopp (min)"],
      ] as const).map(([key, label]) => <label className="space-y-1 text-sm" key={key}>
        <span>Önskad gräns: {label}</span>
        <Input type="number" min={0} max={1440} step={1} value={inputs?.[key] ?? (loadFailed ? "" : defaults?.[key] ?? "")}
          placeholder="Hämtar företagets standard…"
          onChange={event => {
            if (event.target.value === "") return;
            const value = Number(event.target.value);
            if (Number.isInteger(value) && value >= 0 && value <= 1440) onChange({ [key]: value });
          }} />
        <span className="text-xs text-muted-foreground">{inputs?.[key] == null ? "Företagets standard används." : "Planens önskade gräns begränsas av företagets tak."} Effektivt: {effective[key] == null ? "okänt" : `${effective[key]} min`}.</span>
      </label>)}
    </div>}
  </section>;
}
