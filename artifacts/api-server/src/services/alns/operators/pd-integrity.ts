import type { ALNSNode, ALNSSolution } from "../types";

/**
 * Pickup & Delivery same-vehicle integrity guard.
 *
 * P&D orders are modeled as a SINGLE composite ALNS node (delivery coords on
 * the node, pickup coords embedded via pickupLat/pickupLon). Because the
 * pickup and delivery live on one node, destroy/repair operators can never
 * legally place them on different vehicles — the constraint is structural.
 *
 * This guard is defense-in-depth: if a future operator ever duplicates a
 * node across routes (which would effectively split the pickup leg and the
 * delivery leg onto different vehicles) or corrupts a composite node's
 * embedded pickup coordinates, we treat it as a HARD infeasibility and
 * repair the solution in place:
 *   - duplicated node → keep the first occurrence (pickup + delivery stay
 *     together on that vehicle), remove the extras, and fix route load totals
 *   - lost pickup coords → restore them from the reference node
 *
 * Returns the list of violations found (empty when the solution was clean).
 */
export interface PdIntegrityViolation {
  nodeId: string;
  kind: "duplicated_across_vehicles" | "duplicated_within_route" | "lost_pickup_coords";
}

export function enforcePdIntegrity(
  solution: ALNSSolution,
  referenceNodes?: Map<string, ALNSNode>,
): PdIntegrityViolation[] {
  const violations: PdIntegrityViolation[] = [];
  const seen = new Map<string, string>(); // nodeId -> vehicleId of first occurrence

  for (const route of solution.routes) {
    const keep: ALNSNode[] = [];
    for (const node of route.nodes) {
      if (node.isChargingStation) {
        keep.push(node);
        continue;
      }

      const firstVehicle = seen.get(node.id);
      if (firstVehicle !== undefined) {
        // Hard infeasibility: same order assigned twice. Keeping the first
        // occurrence keeps pickup + delivery together on ONE vehicle.
        violations.push({
          nodeId: node.id,
          kind: firstVehicle === route.vehicleId
            ? "duplicated_within_route"
            : "duplicated_across_vehicles",
        });
        route.totalWeight -= node.weightKg;
        route.totalVolume -= node.volumeM3;
        continue;
      }

      const ref = referenceNodes?.get(node.id);
      if (ref && ref.pickupLat != null && ref.pickupLon != null &&
          (node.pickupLat == null || node.pickupLon == null)) {
        // Composite node lost its pickup leg — restore it so the pickup is
        // always serviced by the same vehicle, immediately before delivery.
        node.pickupLat = ref.pickupLat;
        node.pickupLon = ref.pickupLon;
        node.pickupServiceMin = ref.pickupServiceMin;
        violations.push({ nodeId: node.id, kind: "lost_pickup_coords" });
      }

      seen.set(node.id, route.vehicleId);
      keep.push(node);
    }
    route.nodes = keep;
  }

  // Also dedupe unassigned against assigned nodes.
  const cleanUnassigned: ALNSNode[] = [];
  for (const node of solution.unassigned) {
    if (node.isChargingStation) continue;
    if (seen.has(node.id) || cleanUnassigned.some(n => n.id === node.id)) {
      violations.push({ nodeId: node.id, kind: "duplicated_across_vehicles" });
      continue;
    }
    cleanUnassigned.push(node);
  }
  solution.unassigned = cleanUnassigned;

  return violations;
}

/** Build a reference map of composite nodes for pickup-coordinate restoration. */
export function buildPdReferenceMap(nodes: ALNSNode[]): Map<string, ALNSNode> {
  const map = new Map<string, ALNSNode>();
  for (const n of nodes) {
    if (n.pickupLat != null && n.pickupLon != null) map.set(n.id, n);
  }
  return map;
}
