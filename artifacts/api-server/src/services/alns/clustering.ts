import type { ALNSNode, ALNSRoute, ALNSVehicle, ALNSDriverConstraints, OptimizationWeights, RouteEvaluation } from "./types";
import { randomInt } from "./types";
import { haversineDistance, cachedDistance } from "./distance-cache";
import { evaluateRoute } from "./cost";

export function kMeansCluster(nodes: ALNSNode[], k: number, maxIter = 20): ALNSNode[][] {
  if (nodes.length <= k) return nodes.map(n => [n]);

  const centroids: { lat: number; lng: number }[] = [];
  const step = Math.floor(nodes.length / k);
  const sorted = [...nodes].sort((a, b) => a.latitude - b.latitude || a.longitude - b.longitude);
  for (let i = 0; i < k; i++) {
    const n = sorted[Math.min(i * step, sorted.length - 1)];
    centroids.push({ lat: n.latitude, lng: n.longitude });
  }

  let assignments = new Array<number>(nodes.length).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < nodes.length; i++) {
      let bestCluster = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const d = haversineDistance(nodes[i].latitude, nodes[i].longitude, centroids[c].lat, centroids[c].lng);
        if (d < bestDist) {
          bestDist = d;
          bestCluster = c;
        }
      }
      if (assignments[i] !== bestCluster) {
        assignments[i] = bestCluster;
        changed = true;
      }
    }
    if (!changed) break;

    for (let c = 0; c < k; c++) {
      let sumLat = 0, sumLng = 0, count = 0;
      for (let i = 0; i < nodes.length; i++) {
        if (assignments[i] === c) {
          sumLat += nodes[i].latitude;
          sumLng += nodes[i].longitude;
          count++;
        }
      }
      if (count > 0) {
        centroids[c] = { lat: sumLat / count, lng: sumLng / count };
      }
    }
  }

  const clusters: ALNSNode[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < nodes.length; i++) {
    clusters[assignments[i]].push(nodes[i]);
  }
  return clusters.filter(c => c.length > 0);
}

function temporalDistance(a: ALNSNode, b: ALNSNode): number {
  if (!a.timeWindowStart || !a.timeWindowEnd || !b.timeWindowStart || !b.timeWindowEnd) return 0;
  const aStart = a.timeWindowStart.getTime();
  const aEnd = a.timeWindowEnd.getTime();
  const bStart = b.timeWindowStart.getTime();
  const bEnd = b.timeWindowEnd.getTime();
  const overlapStart = Math.max(aStart, bStart);
  const overlapEnd = Math.min(aEnd, bEnd);
  if (overlapEnd > overlapStart) {
    const overlap = overlapEnd - overlapStart;
    const minWindow = Math.min(aEnd - aStart, bEnd - bStart);
    return minWindow > 0 ? 1 - overlap / minWindow : 0;
  }
  const gapMs = overlapStart - overlapEnd;
  const gapHours = gapMs / 3600000;
  return 1 + Math.min(gapHours, 4);
}

function compositeDistance(a: ALNSNode, b: ALNSNode, wGeo: number, wTime: number, maxGeoKm: number): number {
  const geoDist = haversineDistance(a.latitude, a.longitude, b.latitude, b.longitude);
  const normalizedGeo = maxGeoKm > 0 ? geoDist / maxGeoKm : 0;
  const timeDist = temporalDistance(a, b);
  const normalizedTime = timeDist / 5;
  return wGeo * normalizedGeo + wTime * normalizedTime;
}

function computeAdaptiveEps(nodes: ALNSNode[], wGeo: number, wTime: number, maxGeoKm: number, targetClusterSize: number): number {
  const sampleSize = Math.min(nodes.length, 50);
  const indices: number[] = [];
  const step = Math.max(1, Math.floor(nodes.length / sampleSize));
  for (let i = 0; i < nodes.length && indices.length < sampleSize; i += step) {
    indices.push(i);
  }

  const kNeighbors = Math.min(targetClusterSize, Math.max(4, Math.floor(Math.sqrt(nodes.length))));
  const kDistances: number[] = [];

  for (const i of indices) {
    const dists: number[] = [];
    for (let j = 0; j < nodes.length; j++) {
      if (j === i) continue;
      dists.push(compositeDistance(nodes[i], nodes[j], wGeo, wTime, maxGeoKm));
    }
    dists.sort((a, b) => a - b);
    if (dists.length >= kNeighbors) {
      kDistances.push(dists[kNeighbors - 1]);
    }
  }

  kDistances.sort((a, b) => a - b);
  const medianIdx = Math.floor(kDistances.length * 0.5);
  return kDistances[medianIdx] ?? 0.3;
}

function dbscanCluster(
  nodes: ALNSNode[],
  eps: number,
  minPts: number,
  wGeo: number,
  wTime: number,
  maxGeoKm: number
): { clusters: number[][]; noise: number[] } {
  const n = nodes.length;
  const labels = new Array<number>(n).fill(-1);
  const visited = new Array<boolean>(n).fill(false);
  let clusterId = 0;

  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    visited[i] = true;

    const neighbors = regionQuery(i, eps);
    if (neighbors.length < minPts) {
      labels[i] = -1;
      continue;
    }

    labels[i] = clusterId;
    const queue = [...neighbors.filter(j => j !== i)];
    const inQueue = new Set<number>(queue);
    let qi = 0;

    while (qi < queue.length) {
      const j = queue[qi++];
      if (!visited[j]) {
        visited[j] = true;
        const jNeighbors = regionQuery(j, eps);
        if (jNeighbors.length >= minPts) {
          for (const k of jNeighbors) {
            if (!inQueue.has(k) && labels[k] === -1) {
              queue.push(k);
              inQueue.add(k);
            }
          }
        }
      }
      if (labels[j] === -1) {
        labels[j] = clusterId;
      }
    }

    clusterId++;
  }

  function regionQuery(idx: number, radius: number): number[] {
    const result: number[] = [];
    for (let j = 0; j < n; j++) {
      if (compositeDistance(nodes[idx], nodes[j], wGeo, wTime, maxGeoKm) <= radius) {
        result.push(j);
      }
    }
    return result;
  }

  const clusters: number[][] = Array.from({ length: clusterId }, () => []);
  const noise: number[] = [];
  for (let i = 0; i < n; i++) {
    if (labels[i] >= 0) {
      clusters[labels[i]].push(i);
    } else {
      noise.push(i);
    }
  }

  return { clusters, noise };
}

export function consensusClustering(
  nodes: ALNSNode[],
  targetClusterSize: number,
  runs = 5
): { clusters: ALNSNode[][]; borderStopIds: Set<string> } {
  const W_GEO = 0.6;
  const W_TIME = 0.4;
  const minPts = Math.max(3, Math.floor(targetClusterSize * 0.15));

  let maxGeoKm = 0;
  const sampleN = Math.min(nodes.length, 80);
  const sStep = Math.max(1, Math.floor(nodes.length / sampleN));
  for (let i = 0; i < nodes.length; i += sStep) {
    for (let j = i + sStep; j < nodes.length; j += sStep) {
      const d = haversineDistance(nodes[i].latitude, nodes[i].longitude, nodes[j].latitude, nodes[j].longitude);
      if (d > maxGeoKm) maxGeoKm = d;
    }
  }

  const baseEps = computeAdaptiveEps(nodes, W_GEO, W_TIME, maxGeoKm, targetClusterSize);

  const pairCount = new Map<string, number>();
  const pairKey = (i: number, j: number) => i < j ? `${i}:${j}` : `${j}:${i}`;

  for (let run = 0; run < runs; run++) {
    const epsVariation = baseEps * (0.7 + 0.6 * (run / Math.max(1, runs - 1))) * (0.9 + 0.2 * Math.random());
    const runMinPts = Math.max(2, minPts + Math.floor((Math.random() - 0.5) * 2));
    const result = dbscanCluster(nodes, epsVariation, runMinPts, W_GEO, W_TIME, maxGeoKm);

    for (const cluster of result.clusters) {
      for (let a = 0; a < cluster.length; a++) {
        for (let b = a + 1; b < cluster.length; b++) {
          const key = pairKey(cluster[a], cluster[b]);
          pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
        }
      }
    }

    for (const ni of result.noise) {
      let bestCluster = -1;
      let bestDist = Infinity;
      for (let ci = 0; ci < result.clusters.length; ci++) {
        for (const m of result.clusters[ci]) {
          const d = compositeDistance(nodes[ni], nodes[m], W_GEO, W_TIME, maxGeoKm);
          if (d < bestDist) {
            bestDist = d;
            bestCluster = ci;
          }
        }
      }
      if (bestCluster >= 0) {
        for (const m of result.clusters[bestCluster]) {
          const key = pairKey(ni, m);
          pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
        }
      }
    }
  }

  const threshold = runs * 0.5;
  const assignments = new Array<number>(nodes.length).fill(-1);
  let nextCluster = 0;
  const borderStopIds = new Set<string>();

  for (let i = 0; i < nodes.length; i++) {
    if (assignments[i] >= 0) continue;
    const component: number[] = [i];
    const queue = [i];
    assignments[i] = nextCluster;

    while (queue.length > 0) {
      const curr = queue.pop()!;
      for (let j = 0; j < nodes.length; j++) {
        if (assignments[j] >= 0) continue;
        const key = pairKey(curr, j);
        if ((pairCount.get(key) ?? 0) >= threshold) {
          assignments[j] = nextCluster;
          queue.push(j);
          component.push(j);
        }
      }
    }
    nextCluster++;
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (assignments[i] === assignments[j]) continue;
      const key = pairKey(i, j);
      const count = pairCount.get(key) ?? 0;
      const freq = count / runs;
      if (freq >= 0.3 && freq <= 0.7) {
        borderStopIds.add(nodes[i].id);
        borderStopIds.add(nodes[j].id);
      }
    }
  }

  const clusterMap = new Map<number, ALNSNode[]>();
  for (let i = 0; i < nodes.length; i++) {
    const c = assignments[i];
    if (!clusterMap.has(c)) clusterMap.set(c, []);
    clusterMap.get(c)!.push(nodes[i]);
  }

  let clusters = Array.from(clusterMap.values()).filter(c => c.length > 0);

  const maxClusterFraction = 0.8;
  const isDegen = clusters.length < 2 || clusters.some(c => c.length > nodes.length * maxClusterFraction);

  if (isDegen) {
    const numClusters = Math.max(2, Math.ceil(nodes.length / targetClusterSize));
    clusters = kMeansCluster(nodes, numClusters);
    borderStopIds.clear();
  }

  return { clusters, borderStopIds };
}

export function crossClusterImprove(
  allRoutes: ALNSRoute[],
  borderStopIds: Set<string>,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  weights: OptimizationWeights,
  driverConstraintsMap: Map<string, ALNSDriverConstraints>,
  timeBudgetMs = 2000
): void {
  if (borderStopIds.size === 0) return;
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
  const startMs = Date.now();

  const borderNodes: { node: ALNSNode; route: ALNSRoute; routeIdx: number }[] = [];
  for (let ri = 0; ri < allRoutes.length; ri++) {
    for (const node of allRoutes[ri].nodes) {
      if (!node.isChargingStation && borderStopIds.has(node.id)) {
        borderNodes.push({ node, route: allRoutes[ri], routeIdx: ri });
      }
    }
  }

  let improved = true;
  while (improved) {
    if (Date.now() - startMs >= timeBudgetMs) break;
    improved = false;

    for (const bn of borderNodes) {
      if (Date.now() - startMs >= timeBudgetMs) break;

      const sourceRoute = bn.route;
      const sourceVehicle = vehicleMap.get(sourceRoute.vehicleId);
      if (!sourceVehicle) continue;

      const sourceEval = evaluateRoute(sourceRoute, sourceVehicle, depotLat, depotLon, startTime,
        driverConstraintsMap.get(sourceRoute.vehicleId));

      for (let ri = 0; ri < allRoutes.length; ri++) {
        if (allRoutes[ri] === sourceRoute) continue;
        const targetRoute = allRoutes[ri];
        const targetVehicle = vehicleMap.get(targetRoute.vehicleId);
        if (!targetVehicle) continue;

        if (targetRoute.totalWeight + bn.node.weightKg > targetVehicle.capacityKg) continue;
        if (targetRoute.totalVolume + bn.node.volumeM3 > targetVehicle.capacityVolume) continue;

        const srcNodesWithout = sourceRoute.nodes.filter(n => n.id !== bn.node.id);
        const srcTest: ALNSRoute = {
          ...sourceRoute,
          nodes: srcNodesWithout,
          totalWeight: sourceRoute.totalWeight - bn.node.weightKg,
          totalVolume: sourceRoute.totalVolume - bn.node.volumeM3,
        };
        const srcEvalNew = evaluateRoute(srcTest, sourceVehicle, depotLat, depotLon, startTime,
          driverConstraintsMap.get(sourceRoute.vehicleId));
        if (!srcEvalNew.feasible) continue;

        const targetEval = evaluateRoute(targetRoute, targetVehicle, depotLat, depotLon, startTime,
          driverConstraintsMap.get(targetRoute.vehicleId));

        const evalCost = (e: RouteEvaluation) =>
          weights.distanceWeight * e.totalDistanceKm +
          weights.co2Weight * e.totalCo2Kg * 100 +
          weights.etaPrecisionWeight * (e.totalTimeWindowSlackMin / 60) * 10;

        let bestPos = -1;
        let bestImprovement = 0;
        for (let pos = 0; pos <= targetRoute.nodes.length; pos++) {
          const testNodes = [...targetRoute.nodes];
          testNodes.splice(pos, 0, bn.node);
          const tgtTest: ALNSRoute = {
            ...targetRoute,
            nodes: testNodes,
            totalWeight: targetRoute.totalWeight + bn.node.weightKg,
            totalVolume: targetRoute.totalVolume + bn.node.volumeM3,
          };
          const tgtEvalNew = evaluateRoute(tgtTest, targetVehicle, depotLat, depotLon, startTime,
            driverConstraintsMap.get(targetRoute.vehicleId));
          if (!tgtEvalNew.feasible) continue;

          const oldCost = evalCost(sourceEval) + evalCost(targetEval);
          const newCost = evalCost(srcEvalNew) + evalCost(tgtEvalNew);
          const improvement = oldCost - newCost;

          if (improvement > 0.01 && improvement > bestImprovement) {
            bestImprovement = improvement;
            bestPos = pos;
          }
        }

        if (bestPos >= 0) {
          sourceRoute.nodes = srcNodesWithout;
          sourceRoute.totalWeight -= bn.node.weightKg;
          sourceRoute.totalVolume -= bn.node.volumeM3;
          targetRoute.nodes.splice(bestPos, 0, bn.node);
          targetRoute.totalWeight += bn.node.weightKg;
          targetRoute.totalVolume += bn.node.volumeM3;
          bn.route = targetRoute;
          bn.routeIdx = ri;
          improved = true;
          break;
        }
      }
    }
  }
}
