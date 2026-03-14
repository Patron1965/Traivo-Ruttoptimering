import { eq } from "drizzle-orm";
import { db, routesTable, vehiclesTable } from "@workspace/db";
import { calculateCo2Kg, baselineFossilCo2Kg, EMISSION_PROFILES } from "../lib/co2-profiles";

export interface SustainabilityStats {
  totalCo2Kg: number;
  fossilCo2Kg: number;
  evCo2Kg: number;
  hybridCo2Kg: number;
  co2SavedKg: number;
  treesEquivalent: number;
  emissionProfiles: typeof EMISSION_PROFILES;
  routeBreakdown: RouteBreakdownItem[];
}

interface RouteBreakdownItem {
  routeId: string;
  routeName: string;
  vehicleName: string;
  vehicleType: string;
  distanceKm: number;
  co2Kg: number;
  date: string;
}

export async function calculateSustainabilityStats(organizationId: string): Promise<SustainabilityStats> {
  const routeData = await db
    .select({
      routeId: routesTable.id,
      routeName: routesTable.name,
      vehicleName: vehiclesTable.name,
      vehicleType: vehiclesTable.vehicleType,
      distanceKm: routesTable.totalDistanceKm,
      co2Kg: routesTable.co2EmissionsKg,
      date: routesTable.date,
    })
    .from(routesTable)
    .leftJoin(vehiclesTable, eq(routesTable.vehicleId, vehiclesTable.id))
    .where(eq(routesTable.organizationId, organizationId));

  let totalCo2Kg = 0;
  let fossilCo2Kg = 0;
  let evCo2Kg = 0;
  let hybridCo2Kg = 0;

  const routeBreakdown = routeData.map((r) => {
    const dist = Number(r.distanceKm ?? 0);
    const vType = (r.vehicleType ?? "fossil") as string;
    const co2 = r.co2Kg != null ? Number(r.co2Kg) : calculateCo2Kg(dist, vType);

    totalCo2Kg += co2;
    if (vType === "electric") {
      evCo2Kg += co2;
    } else if (vType === "hybrid") {
      hybridCo2Kg += co2;
    } else {
      fossilCo2Kg += co2;
    }

    return {
      routeId: r.routeId,
      routeName: r.routeName,
      vehicleName: r.vehicleName ?? "Unknown",
      vehicleType: vType,
      distanceKm: Math.round(dist * 100) / 100,
      co2Kg: Math.round(co2 * 100) / 100,
      date: r.date?.toISOString() ?? new Date().toISOString(),
    };
  });

  const totalDistAllRoutes = routeData.reduce(
    (sum, r) => sum + Number(r.distanceKm ?? 0),
    0
  );
  const allFossilCo2 = baselineFossilCo2Kg(totalDistAllRoutes);
  const co2SavedKg = Math.max(0, allFossilCo2 - totalCo2Kg);
  const treesEquivalent = Math.round((co2SavedKg / 21.77) * 10) / 10;

  return {
    totalCo2Kg: Math.round(totalCo2Kg * 100) / 100,
    fossilCo2Kg: Math.round(fossilCo2Kg * 100) / 100,
    evCo2Kg: Math.round(evCo2Kg * 100) / 100,
    hybridCo2Kg: Math.round(hybridCo2Kg * 100) / 100,
    co2SavedKg: Math.round(co2SavedKg * 100) / 100,
    treesEquivalent,
    emissionProfiles: EMISSION_PROFILES,
    routeBreakdown,
  };
}
