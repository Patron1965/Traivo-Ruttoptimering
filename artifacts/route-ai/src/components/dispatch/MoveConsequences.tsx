import type { PlannerRecommendation } from "@/lib/planner-corrections";

function value(value: string | number | null, unit = "") {
  if (value == null) return "Okänt";
  if (typeof value === "string" && value.includes("T") && Number.isFinite(Date.parse(value))) {
    return new Date(value).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" });
  }
  return `${typeof value === "number" ? Math.round(value * 100) / 100 : value}${unit}`;
}

export function MoveConsequences({ consequences }: { consequences?: PlannerRecommendation["consequences"] }) {
  if (!consequences) return <p className="text-xs text-muted-foreground">Konsekvensunderlag saknas.</p>;
  return <section className="max-h-64 space-y-3 overflow-y-auto text-xs" aria-label="Konsekvens före och efter">
    {consequences.reason && <p>{consequences.reason}</p>}
    {consequences.unplanned && <p>Ej tilldelade i urvalet: {consequences.unplanned.before} → {consequences.unplanned.after}</p>}
    {consequences.routes?.map(route => <table key={route.routeId} className="w-full text-left">
      <caption className="pb-1 text-left font-semibold">{route.routeName}</caption>
      <thead><tr><th>Mått</th><th>Före</th><th>Efter</th></tr></thead>
      <tbody>
        <tr><th className="font-normal">Körning</th><td>{value(route.before.driveMin, " min")}</td><td>{value(route.after.driveMin, " min")}</td></tr>
        <tr><th className="font-normal">Arbetstid</th><td>{value(route.before.workMin, " min")}</td><td>{value(route.after.workMin, " min")}</td></tr>
        <tr><th className="font-normal">Sluttid</th><td>{value(route.before.endAt)}</td><td>{value(route.after.endAt)}</td></tr>
        <tr><th className="font-normal">Tidsfönsteravvikelser</th><td>{value(route.before.windowViolations)}</td><td>{value(route.after.windowViolations)}</td></tr>
        <tr><th className="font-normal">Uppdrag</th><td>{route.before.stopCount}</td><td>{route.after.stopCount}</td></tr>
      </tbody>
    </table>)}
  </section>;
}
