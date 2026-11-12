import type { ALNSNode, ALNSRoute } from "./types";
import { haversineDistance } from "./distance-cache";
import { getCachedOsrmDistance, getRoadCacheRevision } from "../osrm";
import { requiresRoadData, RoadDataUnavailableError } from "../road-data-policy";
import { operationalProviderCacheKey } from "../operational-provider-config";

const RADIUS_KM = 10;
const CANDIDATES = 24;
export const NEIGHBOR_COUNT = 6;
type Point = { node: ALNSNode; xyz: number[] };
type Tree = { point: Point; axis: number; left?: Tree; right?: Tree };

function tree(points: Point[], depth = 0): Tree | undefined {
  if (!points.length) return undefined;
  const axis = depth % 3;
  points.sort((a, b) => a.xyz[axis] - b.xyz[axis] || a.node.id.localeCompare(b.node.id));
  const middle = Math.floor(points.length / 2);
  return { point: points[middle], axis, left: tree(points.slice(0, middle), depth + 1), right: tree(points.slice(middle + 1), depth + 1) };
}

/** Bounded road shortlist: no provider calls, no operational straight-line fallback.
 * Both directions matter: an accessible outbound edge must not hide a barrier
 * on the return. Analytical callers explicitly outside required-road policy may
 * use geodesic distance only when neither direction is cached.
 */
export function neighborhoodDistance(a: ALNSNode, b: ALNSNode): number {
  if (a.latitude === b.latitude && a.longitude === b.longitude) return 0;
  const forward = getCachedOsrmDistance(a.latitude, a.longitude, b.latitude, b.longitude);
  const reverse = getCachedOsrmDistance(b.latitude, b.longitude, a.latitude, a.longitude);
  if (forward && reverse) return Math.max(forward.distanceKm, reverse.distanceKm);
  if (requiresRoadData()) throw new RoadDataUnavailableError();
  if (forward || reverse) return (forward ?? reverse)!.distanceKm;
  return haversineDistance(a.latitude, a.longitude, b.latitude, b.longitude);
}

export type Neighborhood = Map<string, Array<{ node: ALNSNode; weight: number }>>;
type Graph = Map<string, Array<{ id: string; weight: number }>>;
// Cache only identifiers/weights, never mutable job objects. Keys include the
// complete assigned stop identity/coordinates, tenant/provider partition, and
// road requirement. Any road mutation invalidates all entries, including
// analytical graphs warmed before road data arrived. Small bounded LRU avoids
// retaining arbitrary customer coordinate sets for the lifetime of the server.
const graphCache = new Map<string, Graph>();
let graphRoadRevision = -1;
const MAX_CACHED_GRAPHS = 16;

function assignmentGraph(nodes: ALNSNode[]): Graph {
  const revision = getRoadCacheRevision();
  if (revision !== graphRoadRevision) {
    graphCache.clear();
    graphRoadRevision = revision;
  }
  const customers = nodes.filter(n => !n.isChargingStation);
  const coordinates = customers.map(n => [n.id, n.latitude, n.longitude] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const key = JSON.stringify([operationalProviderCacheKey(), requiresRoadData(), coordinates]);
  const cached = graphCache.get(key);
  if (cached) {
    graphCache.delete(key);
    graphCache.set(key, cached);
    return cached;
  }
  const graph: Graph = new Map([...buildUncachedNeighborhood(customers)].map(([id, neighbors]) => [
    id, neighbors.map(item => ({ id: item.node.id, weight: item.weight })),
  ]));
  if (graphCache.size >= MAX_CACHED_GRAPHS) graphCache.delete(graphCache.keys().next().value!);
  graphCache.set(key, graph);
  return graph;
}

export function buildNeighborhood(nodes: ALNSNode[]): Neighborhood {
  const currentNodes = new Map(nodes.map(n => [n.id, n]));
  return new Map([...assignmentGraph(nodes)].map(([id, neighbors]) => [
    id, neighbors.map(item => ({ node: currentNodes.get(item.id)!, weight: item.weight })),
  ]));
}

/** Exact geodesic nearest-24 shortlist, then nearest-6 by available road distance.
 * Dense neighborhoods cannot generate a quadratic all-pairs objective. Each
 * stop contributes one normalized vote, rather than dense areas dominating.
 */
function buildUncachedNeighborhood(nodes: ALNSNode[]): Neighborhood {
  const points = nodes.filter(n => !n.isChargingStation).map(node => {
    const lat = node.latitude * Math.PI / 180, lon = node.longitude * Math.PI / 180;
    return { node, xyz: [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)] };
  });
  const root = tree([...points]);
  const result: Neighborhood = new Map();
  for (const point of points) {
    const nearest: Array<{ point: Point; distance: number }> = [];
    const visit = (branch?: Tree): void => {
      if (!branch) return;
      const delta = point.xyz[branch.axis] - branch.point.xyz[branch.axis];
      if (branch.point.node.id !== point.node.id) {
        const distance = point.xyz.reduce((sum, x, i) => sum + (x - branch.point.xyz[i]) ** 2, 0);
        nearest.push({ point: branch.point, distance });
        nearest.sort((a, b) => a.distance - b.distance || a.point.node.id.localeCompare(b.point.node.id));
        if (nearest.length > CANDIDATES) nearest.pop();
      }
      visit(delta < 0 ? branch.left : branch.right);
      if (nearest.length < CANDIDATES || delta * delta < nearest[nearest.length - 1].distance) {
        visit(delta < 0 ? branch.right : branch.left);
      }
    };
    visit(root);
    const neighbors = nearest
      .filter(item => haversineDistance(point.node.latitude, point.node.longitude, item.point.node.latitude, item.point.node.longitude) < RADIUS_KM)
      .map(item => ({ node: item.point.node, distance: neighborhoodDistance(point.node, item.point.node) }))
      .filter(item => item.distance < RADIUS_KM)
      .sort((a, b) => a.distance - b.distance || a.node.id.localeCompare(b.node.id))
      .slice(0, NEIGHBOR_COUNT);
    result.set(point.node.id, neighbors.map(item => ({ node: item.node, weight: 1 / (0.1 + item.distance) })));
  }
  return result;
}

export function localAssignmentCost(routes: ALNSRoute[]): number {
  const owners = new Map(routes.flatMap(route => route.nodes.filter(n => !n.isChargingStation).map(n => [n.id, route.vehicleId] as const)));
  const graph = assignmentGraph(routes.flatMap(route => route.nodes));
  let votes = 0, split = 0;
  for (const [id, neighbors] of graph) {
    const total = neighbors.reduce((sum, item) => sum + item.weight, 0);
    if (!total) continue;
    votes++;
    split += neighbors.reduce((sum, item) => sum + (owners.get(id) !== owners.get(item.id) ? item.weight : 0), 0) / total;
  }
  return votes ? split / votes : 0;
}
