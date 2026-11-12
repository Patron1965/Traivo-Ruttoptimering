import type { ALNSNode } from "./types";
import { cachedDistance } from "./distance-cache";

/** Road medoids are soft seeds, not capacity claims or permanent district boundaries. */
export function roadMedoidClusters(nodes: ALNSNode[], size = 60) {
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const count = Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length / size)));
  const distance = (a: ALNSNode, b: ALNSNode) => (
    cachedDistance(a.latitude, a.longitude, b.latitude, b.longitude) +
    cachedDistance(b.latitude, b.longitude, a.latitude, a.longitude)
  ) / 2;
  if (!sorted.length) return { clusters: [], borderStopIds: new Set<string>() };
  const centers = [sorted[0]];
  while (centers.length < count) {
    const remaining = sorted.filter(n => !centers.includes(n));
    remaining.sort((a, b) => Math.min(...centers.map(c => distance(b, c))) -
      Math.min(...centers.map(c => distance(a, c))) || a.id.localeCompare(b.id));
    centers.push(remaining[0]);
  }
  let groups: ALNSNode[][] = [];
  for (let pass = 0; pass < 3; pass++) {
    groups = centers.map(() => []);
    for (const node of sorted) {
      let best = 0;
      for (let i = 1; i < centers.length; i++) if (distance(node, centers[i]) < distance(node, centers[best])) best = i;
      groups[best].push(node);
    }
    if (pass === 2) break;
    groups.forEach((group, i) => {
      if (!group.length) return;
      // Bounded candidate medoids for large inputs; assignment still uses road distances.
      const stride = Math.max(1, Math.ceil(group.length / 32));
      centers[i] = group.filter((_, j) => j % stride === 0).map(node => ({
        node, cost: group.reduce((sum, other) => sum + distance(node, other), 0),
      })).sort((a, b) => a.cost - b.cost || a.node.id.localeCompare(b.node.id))[0].node;
    });
  }
  const borderStopIds = new Set<string>();
  for (const node of sorted) {
    const distances = centers.map(c => distance(node, c)).sort((a, b) => a - b);
    if (distances.length > 1 && distances[1] <= distances[0] * 1.25 + .1) borderStopIds.add(node.id);
  }
  return { clusters: groups.filter(g => g.length), borderStopIds };
}
