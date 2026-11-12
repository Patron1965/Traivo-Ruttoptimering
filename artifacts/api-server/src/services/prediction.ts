export interface PredictionCell {
  lat: number;
  lng: number;
  congestionScore: number;
  predictedDelayMin: number;
}

export interface PredictionMetadata {
  /**
   * This endpoint is deliberately simulation-only. Keeping the source in the
   * response makes it impossible for a consumer to mistake these values for
   * a live traffic feed.
   */
  source: "simulation";
  mode: "simulation";
  isSimulation: true;
  generatedAt: string;
  horizonMinutes: number;
}

export interface PredictionResponse {
  metadata: PredictionMetadata;
  cells: PredictionCell[];
}

const STOCKHOLM_BOUNDS = {
  minLat: 59.25,
  maxLat: 59.42,
  minLng: 17.85,
  maxLng: 18.20,
};

const CELL_SIZE = 0.008;

const CONGESTION_HOTSPOTS = [
  { lat: 59.330, lng: 18.070, radius: 0.015, name: "T-Centralen", historicalDelay: 4.2 },
  { lat: 59.335, lng: 18.055, name: "Norrmalm", radius: 0.012, historicalDelay: 3.8 },
  { lat: 59.310, lng: 18.075, name: "Södermalm", radius: 0.013, historicalDelay: 3.5 },
  { lat: 59.340, lng: 18.000, name: "Kungsholmen", radius: 0.010, historicalDelay: 2.9 },
  { lat: 59.345, lng: 18.080, name: "Östermalm", radius: 0.012, historicalDelay: 3.1 },
  { lat: 59.290, lng: 18.080, name: "Globen", radius: 0.008, historicalDelay: 2.2 },
  { lat: 59.360, lng: 17.950, name: "Solna", radius: 0.010, historicalDelay: 2.5 },
  { lat: 59.370, lng: 18.010, name: "Karolinska", radius: 0.008, historicalDelay: 1.8 },
  { lat: 59.315, lng: 18.050, name: "Hornstull", radius: 0.008, historicalDelay: 2.0 },
  { lat: 59.350, lng: 18.110, name: "Gärdet", radius: 0.007, historicalDelay: 1.5 },
];

function getRushHourFactor(date: Date): number {
  const hour = date.getHours();
  const day = date.getDay();
  const isWeekend = day === 0 || day === 6;

  if (isWeekend) return 0.3;

  if (hour >= 7 && hour <= 9) {
    const peak = hour === 8 ? 1.0 : 0.8;
    return peak;
  }
  if (hour >= 16 && hour <= 18) {
    const peak = hour === 17 ? 1.0 : 0.8;
    return peak;
  }
  if (hour >= 11 && hour <= 13) return 0.5;
  if (hour >= 22 || hour <= 5) return 0.1;
  return 0.35;
}

function seededRandom(x: number, y: number, t: number): number {
  const seed = Math.sin(x * 12.9898 + y * 78.233 + t * 43.7) * 43758.5453;
  return seed - Math.floor(seed);
}

function normalizeHorizon(horizonMinutes: number): number {
  if (!Number.isFinite(horizonMinutes)) return 30;
  return Math.max(0, Math.min(Math.trunc(horizonMinutes), 240));
}

export function generatePredictions(
  bounds: { lat1: number; lng1: number; lat2: number; lng2: number },
  horizonMinutes: number = 30
): PredictionCell[] {
  const normalizedHorizon = normalizeHorizon(horizonMinutes);
  const now = new Date();
  const futureTime = new Date(now.getTime() + normalizedHorizon * 60000);
  const rushFactor = getRushHourFactor(futureTime);
  const timeSeed = Math.floor(now.getTime() / 30000);

  const minLat = Math.max(bounds.lat1, STOCKHOLM_BOUNDS.minLat);
  const maxLat = Math.min(bounds.lat2, STOCKHOLM_BOUNDS.maxLat);
  const minLng = Math.max(bounds.lng1, STOCKHOLM_BOUNDS.minLng);
  const maxLng = Math.min(bounds.lng2, STOCKHOLM_BOUNDS.maxLng);

  const cells: PredictionCell[] = [];

  for (let lat = minLat; lat <= maxLat; lat += CELL_SIZE) {
    for (let lng = minLng; lng <= maxLng; lng += CELL_SIZE) {
      let hotspotInfluence = 0;
      let historicalDelayFactor = 0;
      for (const hs of CONGESTION_HOTSPOTS) {
        const dist = Math.sqrt((lat - hs.lat) ** 2 + (lng - hs.lng) ** 2);
        if (dist < hs.radius * 2) {
          const influence = Math.max(0, 1 - dist / (hs.radius * 2));
          if (influence > hotspotInfluence) {
            hotspotInfluence = influence;
            historicalDelayFactor = (hs.historicalDelay / 5) * influence;
          }
        }
      }

      const noise = seededRandom(lat, lng, timeSeed) * 0.2 - 0.1;
      const congestionScore = Math.max(0, Math.min(1,
        hotspotInfluence * rushFactor * 0.7 + historicalDelayFactor * 0.3 + noise
      ));

      if (congestionScore < 0.05) continue;

      const baseDelay = congestionScore * 12;
      const historicalDelay = historicalDelayFactor * rushFactor * 3;
      const predictedDelayMin = Math.round((baseDelay + historicalDelay) * 10) / 10;

      cells.push({
        lat: Math.round(lat * 10000) / 10000,
        lng: Math.round(lng * 10000) / 10000,
        congestionScore: Math.round(congestionScore * 100) / 100,
        predictedDelayMin,
      });
    }
  }

  return cells;
}

export function getDefaultBoundsPredictions(): PredictionCell[] {
  return generatePredictions({
    lat1: STOCKHOLM_BOUNDS.minLat,
    lng1: STOCKHOLM_BOUNDS.minLng,
    lat2: STOCKHOLM_BOUNDS.maxLat,
    lng2: STOCKHOLM_BOUNDS.maxLng,
  });
}

export function createPredictionResponse(
  bounds: { lat1: number; lng1: number; lat2: number; lng2: number },
  horizonMinutes: number = 30,
): PredictionResponse {
  const normalizedHorizon = normalizeHorizon(horizonMinutes);
  return {
    metadata: {
      source: "simulation",
      mode: "simulation",
      isSimulation: true,
      generatedAt: new Date().toISOString(),
      horizonMinutes: normalizedHorizon,
    },
    cells: generatePredictions(bounds, normalizedHorizon),
  };
}

export function getDefaultBoundsPredictionResponse(horizonMinutes: number = 30): PredictionResponse {
  return createPredictionResponse({
    lat1: STOCKHOLM_BOUNDS.minLat,
    lng1: STOCKHOLM_BOUNDS.minLng,
    lat2: STOCKHOLM_BOUNDS.maxLat,
    lng2: STOCKHOLM_BOUNDS.maxLng,
  }, horizonMinutes);
}
