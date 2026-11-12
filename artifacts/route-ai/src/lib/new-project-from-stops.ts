import type { Route, Stop } from "@workspace/api-client-react";

/** Match the before-dispatch contract without guessing missing route state. */
export function newProjectBlockReason(
  stops: Pick<Stop, "routeId" | "status">[],
  routes: Pick<Route, "id" | "name" | "status" | "sentAt" | "handoffStatus">[],
): string | null {
  if (!stops.length) return "Markera minst ett stopp för att skapa ett projekt.";
  if (stops.some(stop => stop.status !== "pending")) {
    return "Urvalet innehåller påbörjade eller avslutade stopp. Endast väntande stopp kan flyttas till ett nytt projekt.";
  }
  for (const id of new Set(stops.flatMap(stop => stop.routeId ? [stop.routeId] : []))) {
    const route = routes.find(item => item.id === id);
    if (!route) return "Källruttens status kunde inte hämtas. Ladda om underlaget innan du fortsätter.";
    if (!["draft", "optimized"].includes(route.status)) {
      return `Rutten ”${route.name}” är påbörjad, avslutad eller avbruten. Stoppen kan inte flyttas till ett nytt projekt.`;
    }
    if (route.sentAt || (route.handoffStatus != null && route.handoffStatus !== "pending")) {
      return `Rutten ”${route.name}” har redan skickats. Nytt projekt med annan chaufför/fordon är bara tillgängligt före utskick.`;
    }
    if (route.handoffStatus !== "pending") {
      return `Utskicksstatus saknas för ”${route.name}”. Ladda om underlaget innan du fortsätter.`;
    }
  }
  return null;
}
