interface TrafficCondition {
  congestionLevel: "free" | "light" | "moderate" | "heavy" | "severe";
  speedMultiplier: number;
  delayMinutes: number;
  incidents: TrafficIncident[];
  updatedAt: Date;
}

interface TrafficIncident {
  lat: number;
  lng: number;
  type: "accident" | "roadwork" | "closure" | "event";
  description: string;
  delayMinutes: number;
  radiusKm: number;
  expiresAt: Date;
}

interface SegmentTraffic {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  multiplier: number;
  reason?: string;
}

const STOCKHOLM_CORRIDORS = [
  { name: "E4 Norr (Solna–Rotebro)", latRange: [59.35, 59.42], lngRange: [17.95, 18.05], peakMultiplier: 1.45 },
  { name: "E4 Syd (Kungens Kurva–Södertälje)", latRange: [59.22, 59.28], lngRange: [17.88, 17.98], peakMultiplier: 1.35 },
  { name: "E18 (Järva–Danderyd)", latRange: [59.37, 59.40], lngRange: [18.00, 18.12], peakMultiplier: 1.40 },
  { name: "Essingeleden", latRange: [59.31, 59.35], lngRange: [17.98, 18.03], peakMultiplier: 1.55 },
  { name: "Centralbron/Söderledstunneln", latRange: [59.315, 59.335], lngRange: [18.06, 18.08], peakMultiplier: 1.50 },
  { name: "Nynäsvägen", latRange: [59.27, 59.31], lngRange: [18.07, 18.12], peakMultiplier: 1.30 },
  { name: "Uppsalavägen", latRange: [59.40, 59.45], lngRange: [17.92, 18.02], peakMultiplier: 1.35 },
];

const activeIncidents: TrafficIncident[] = [];

function getTimeOfDayMultiplier(date: Date): number {
  const hour = date.getHours() + date.getMinutes() / 60;
  const day = date.getDay();
  const isWeekend = day === 0 || day === 6;

  if (isWeekend) {
    if (hour >= 10 && hour <= 15) return 1.1;
    return 1.0;
  }

  if (hour >= 7.5 && hour <= 8.5) return 1.0;
  if (hour >= 7 && hour <= 9) return 0.85;
  if (hour >= 16.5 && hour <= 17.5) return 1.0;
  if (hour >= 16 && hour <= 18) return 0.85;
  if (hour >= 11 && hour <= 13) return 0.45;
  if (hour >= 9 && hour <= 16) return 0.35;
  if (hour >= 22 || hour <= 5) return 0.05;
  return 0.25;
}

function getCorridorMultiplier(lat: number, lng: number, date: Date): number {
  const timeFactor = getTimeOfDayMultiplier(date);
  let maxMultiplier = 1.0;

  for (const corridor of STOCKHOLM_CORRIDORS) {
    if (
      lat >= corridor.latRange[0] && lat <= corridor.latRange[1] &&
      lng >= corridor.lngRange[0] && lng <= corridor.lngRange[1]
    ) {
      const corridorEffect = 1.0 + (corridor.peakMultiplier - 1.0) * timeFactor;
      maxMultiplier = Math.max(maxMultiplier, corridorEffect);
    }
  }

  return Math.round(maxMultiplier * 100) / 100;
}

function getIncidentMultiplier(lat: number, lng: number): { multiplier: number; incident?: TrafficIncident } {
  const now = Date.now();
  let worstMultiplier = 1.0;
  let worstIncident: TrafficIncident | undefined;

  for (const incident of activeIncidents) {
    if (incident.expiresAt.getTime() < now) continue;

    const dist = Math.sqrt((lat - incident.lat) ** 2 + (lng - incident.lng) ** 2) * 111;
    if (dist < incident.radiusKm) {
      const proximity = 1 - dist / incident.radiusKm;
      const delayFactor = 1 + (incident.delayMinutes / 30) * proximity;
      if (delayFactor > worstMultiplier) {
        worstMultiplier = delayFactor;
        worstIncident = incident;
      }
    }
  }

  return { multiplier: Math.round(worstMultiplier * 100) / 100, incident: worstIncident };
}

export function getTrafficMultiplier(
  lat: number,
  lng: number,
  date?: Date
): number {
  const now = date ?? new Date();
  const corridorMult = getCorridorMultiplier(lat, lng, now);
  const { multiplier: incidentMult } = getIncidentMultiplier(lat, lng);
  return Math.round(Math.max(corridorMult, incidentMult) * 100) / 100;
}

export function getSegmentTrafficMultiplier(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  date?: Date
): number {
  const midLat = (fromLat + toLat) / 2;
  const midLng = (fromLng + toLng) / 2;
  const m1 = getTrafficMultiplier(fromLat, fromLng, date);
  const m2 = getTrafficMultiplier(midLat, midLng, date);
  const m3 = getTrafficMultiplier(toLat, toLng, date);
  return Math.round(((m1 + m2 + m3) / 3) * 100) / 100;
}

export function getTrafficConditions(lat: number, lng: number, date?: Date): TrafficCondition {
  const now = date ?? new Date();
  const multiplier = getTrafficMultiplier(lat, lng, now);

  let congestionLevel: TrafficCondition["congestionLevel"];
  if (multiplier <= 1.05) congestionLevel = "free";
  else if (multiplier <= 1.15) congestionLevel = "light";
  else if (multiplier <= 1.3) congestionLevel = "moderate";
  else if (multiplier <= 1.45) congestionLevel = "heavy";
  else congestionLevel = "severe";

  const nearbyIncidents = activeIncidents.filter(inc => {
    const dist = Math.sqrt((lat - inc.lat) ** 2 + (lng - inc.lng) ** 2) * 111;
    return dist < 5 && inc.expiresAt.getTime() > Date.now();
  });

  return {
    congestionLevel,
    speedMultiplier: multiplier,
    delayMinutes: Math.round((multiplier - 1) * 15 * 10) / 10,
    incidents: nearbyIncidents,
    updatedAt: now,
  };
}

export function addIncident(incident: Omit<TrafficIncident, "expiresAt"> & { durationMinutes?: number }): TrafficIncident {
  const newIncident: TrafficIncident = {
    ...incident,
    expiresAt: new Date(Date.now() + (incident.durationMinutes ?? 60) * 60000),
  };
  activeIncidents.push(newIncident);
  return newIncident;
}

export function clearExpiredIncidents(): void {
  const now = Date.now();
  for (let i = activeIncidents.length - 1; i >= 0; i--) {
    if (activeIncidents[i].expiresAt.getTime() < now) {
      activeIncidents.splice(i, 1);
    }
  }
}

export function getActiveIncidents(): TrafficIncident[] {
  clearExpiredIncidents();
  return [...activeIncidents];
}

export function getStockholmTrafficOverview(date?: Date): {
  overall: TrafficCondition["congestionLevel"];
  corridors: { name: string; multiplier: number; level: TrafficCondition["congestionLevel"] }[];
  incidents: TrafficIncident[];
} {
  const now = date ?? new Date();

  const corridors = STOCKHOLM_CORRIDORS.map(c => {
    const midLat = (c.latRange[0] + c.latRange[1]) / 2;
    const midLng = (c.lngRange[0] + c.lngRange[1]) / 2;
    const multiplier = getTrafficMultiplier(midLat, midLng, now);

    let level: TrafficCondition["congestionLevel"];
    if (multiplier <= 1.05) level = "free";
    else if (multiplier <= 1.15) level = "light";
    else if (multiplier <= 1.3) level = "moderate";
    else if (multiplier <= 1.45) level = "heavy";
    else level = "severe";

    return { name: c.name, multiplier, level };
  });

  const avgMult = corridors.reduce((s, c) => s + c.multiplier, 0) / corridors.length;
  let overall: TrafficCondition["congestionLevel"];
  if (avgMult <= 1.05) overall = "free";
  else if (avgMult <= 1.15) overall = "light";
  else if (avgMult <= 1.3) overall = "moderate";
  else if (avgMult <= 1.45) overall = "heavy";
  else overall = "severe";

  return { overall, corridors, incidents: getActiveIncidents() };
}
