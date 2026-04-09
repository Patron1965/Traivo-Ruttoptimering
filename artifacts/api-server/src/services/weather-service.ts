interface WeatherCondition {
  temperature: number;
  windSpeedMs: number;
  precipitationMm: number;
  weatherCode: number;
  description: string;
  drivingImpact: number;
  evRangeMultiplier: number;
}

interface WeatherForecastPoint {
  lat: number;
  lng: number;
  time: Date;
  condition: WeatherCondition;
}

interface CacheEntry {
  data: WeatherCondition;
  expiresAt: number;
}

const weatherCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15 * 60 * 1000;

const WMO_CODE_MAP: Record<number, { desc: string; impact: number }> = {
  0: { desc: "Klart", impact: 1.0 },
  1: { desc: "Mestadels klart", impact: 1.0 },
  2: { desc: "Delvis mulet", impact: 1.0 },
  3: { desc: "Mulet", impact: 1.02 },
  45: { desc: "Dimma", impact: 1.15 },
  48: { desc: "Rimfrostdimma", impact: 1.2 },
  51: { desc: "Lätt duggregn", impact: 1.05 },
  53: { desc: "Måttligt duggregn", impact: 1.1 },
  55: { desc: "Kraftigt duggregn", impact: 1.15 },
  61: { desc: "Lätt regn", impact: 1.1 },
  63: { desc: "Måttligt regn", impact: 1.15 },
  65: { desc: "Kraftigt regn", impact: 1.25 },
  66: { desc: "Lätt underkylt regn", impact: 1.35 },
  67: { desc: "Kraftigt underkylt regn", impact: 1.5 },
  71: { desc: "Lätt snöfall", impact: 1.2 },
  73: { desc: "Måttligt snöfall", impact: 1.35 },
  75: { desc: "Kraftigt snöfall", impact: 1.5 },
  77: { desc: "Snökorn", impact: 1.3 },
  80: { desc: "Lätta regnskurar", impact: 1.1 },
  81: { desc: "Måttliga regnskurar", impact: 1.15 },
  82: { desc: "Kraftiga regnskurar", impact: 1.3 },
  85: { desc: "Lätta snöbyar", impact: 1.25 },
  86: { desc: "Kraftiga snöbyar", impact: 1.45 },
  95: { desc: "Åskväder", impact: 1.4 },
  96: { desc: "Åskväder med hagel", impact: 1.5 },
  99: { desc: "Kraftigt åskväder med hagel", impact: 1.6 },
};

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}

function evRangeForTemperature(tempC: number): number {
  if (tempC >= 20 && tempC <= 30) return 1.0;
  if (tempC >= 15) return 0.95;
  if (tempC >= 10) return 0.9;
  if (tempC >= 5) return 0.85;
  if (tempC >= 0) return 0.78;
  if (tempC >= -5) return 0.72;
  if (tempC >= -10) return 0.65;
  if (tempC >= -15) return 0.6;
  return 0.55;
}

function windImpact(windSpeedMs: number): number {
  if (windSpeedMs < 5) return 1.0;
  if (windSpeedMs < 10) return 1.02;
  if (windSpeedMs < 15) return 1.05;
  if (windSpeedMs < 20) return 1.1;
  return 1.15;
}

export async function getWeatherForLocation(
  lat: number,
  lng: number,
  time?: Date
): Promise<WeatherCondition> {
  const key = cacheKey(lat, lng);
  const now = Date.now();
  const cached = weatherCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current=temperature_2m,wind_speed_10m,precipitation,weather_code&timezone=Europe/Stockholm`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!response.ok) {
      throw new Error(`Open-Meteo API error: ${response.status}`);
    }

    const data = await response.json() as any;
    const current = data.current;

    const weatherCode = current.weather_code ?? 0;
    const wmo = WMO_CODE_MAP[weatherCode] ?? { desc: "Okänt", impact: 1.0 };
    const temp = current.temperature_2m ?? 15;
    const wind = current.wind_speed_10m ? current.wind_speed_10m / 3.6 : 0;
    const precip = current.precipitation ?? 0;

    const combinedImpact = Math.max(wmo.impact, windImpact(wind));

    const condition: WeatherCondition = {
      temperature: temp,
      windSpeedMs: Math.round(wind * 10) / 10,
      precipitationMm: precip,
      weatherCode,
      description: wmo.desc,
      drivingImpact: Math.round(combinedImpact * 100) / 100,
      evRangeMultiplier: evRangeForTemperature(temp),
    };

    weatherCache.set(key, { data: condition, expiresAt: now + CACHE_TTL_MS });
    return condition;
  } catch (err) {
    console.warn("Weather API fallback — using defaults:", (err as Error).message);
    return getFallbackWeather();
  }
}

export async function getWeatherForRoute(
  coordinates: { lat: number; lng: number }[]
): Promise<WeatherCondition> {
  if (coordinates.length === 0) return getFallbackWeather();

  const centerLat = coordinates.reduce((s, c) => s + c.lat, 0) / coordinates.length;
  const centerLng = coordinates.reduce((s, c) => s + c.lng, 0) / coordinates.length;
  return getWeatherForLocation(centerLat, centerLng);
}

export async function getStockholmWeather(): Promise<WeatherCondition> {
  return getWeatherForLocation(59.33, 18.07);
}

function getFallbackWeather(): WeatherCondition {
  return {
    temperature: 12,
    windSpeedMs: 3,
    precipitationMm: 0,
    weatherCode: 2,
    description: "Delvis mulet",
    drivingImpact: 1.0,
    evRangeMultiplier: 0.9,
  };
}

export function getWeatherSeverity(condition: WeatherCondition): "clear" | "mild" | "moderate" | "severe" {
  if (condition.drivingImpact >= 1.4) return "severe";
  if (condition.drivingImpact >= 1.2) return "moderate";
  if (condition.drivingImpact >= 1.05) return "mild";
  return "clear";
}

export function clearWeatherCache(): void {
  weatherCache.clear();
}
