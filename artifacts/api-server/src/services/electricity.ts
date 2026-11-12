import { db, energyPricesTable } from "@workspace/db";
import { eq, and, gte, lte, asc } from "drizzle-orm";

interface PricePoint {
  timestamp: string;
  priceEurMwh: number;
  priceSekKwh: number;
}

interface ChargingWindow {
  start: string;
  end: string;
  avgPriceEurMwh: number;
  avgPriceSekKwh: number;
  savingsPercent: number;
}

const EUR_TO_SEK = 11.5;

const AREA_TO_ENTSOE_DOMAIN: Record<string, string> = {
  SE1: "10Y1001A1001A44P",
  SE2: "10Y1001A1001A45N",
  SE3: "10Y1001A1001A46L",
  SE4: "10Y1001A1001A47J",
};

async function fetchEntsoeSpotPrices(area: string, hours: number): Promise<PricePoint[] | null> {
  const token = process.env.ENTSOE_API_TOKEN;
  if (!token) return null;

  const domain = AREA_TO_ENTSOE_DOMAIN[area];
  if (!domain) return null;

  const now = new Date();
  now.setMinutes(0, 0, 0);
  const end = new Date(now.getTime() + hours * 3600000);

  const fmt = (d: Date) => {
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    const h = String(d.getUTCHours()).padStart(2, "0");
    const mi = String(d.getUTCMinutes()).padStart(2, "0");
    return `${y}${mo}${da}${h}${mi}`;
  };

  const url = `https://web-api.tp.entsoe.eu/api?` +
    `documentType=A44&in_Domain=${domain}&out_Domain=${domain}` +
    `&periodStart=${fmt(now)}&periodEnd=${fmt(end)}&securityToken=${token}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const xml = await res.text();
    const prices: PricePoint[] = [];
    const pointRegex = /<position>(\d+)<\/position>\s*<price\.amount>(-?[\d.]+)<\/price\.amount>/g;
    const startRegex = /<start>([\dTZ:.-]+)<\/start>/;
    const startMatch = xml.match(startRegex);
    const periodStart = startMatch ? new Date(startMatch[1]) : now;

    let match;
    while ((match = pointRegex.exec(xml)) !== null) {
      const position = parseInt(match[1]) - 1;
      const priceEurMwh = parseFloat(match[2]);
      const ts = new Date(periodStart.getTime() + position * 3600000);
      prices.push({
        timestamp: ts.toISOString(),
        priceEurMwh,
        priceSekKwh: Math.round((priceEurMwh / 1000) * EUR_TO_SEK * 100) / 100,
      });
    }

    return prices.length > 0 ? prices.slice(0, hours) : null;
  } catch {
    return null;
  }
}

function generateFallbackPrices(area: string, hours: number): PricePoint[] {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const prices: PricePoint[] = [];

  const basePrice: Record<string, number> = {
    SE1: 28, SE2: 30, SE3: 42, SE4: 45,
  };
  const base = basePrice[area] ?? 40;

  for (let i = 0; i < hours; i++) {
    const t = new Date(now.getTime() + i * 3600000);
    const hour = t.getHours();
    const dayOfWeek = t.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    let factor = 1.0;
    if (isWeekend) {
      factor = 0.7;
    } else if (hour >= 7 && hour <= 9) {
      factor = 1.8 + (hour === 8 ? 0.3 : 0);
    } else if (hour >= 17 && hour <= 19) {
      factor = 1.9 + (hour === 18 ? 0.2 : 0);
    } else if (hour >= 1 && hour <= 5) {
      factor = 0.4 + (hour - 1) * 0.05;
    } else if (hour >= 10 && hour <= 15) {
      factor = 0.9;
    } else if (hour >= 22 || hour === 0) {
      factor = 0.55;
    }

    const noise = Math.sin(i * 7.3 + area.charCodeAt(2) * 0.5) * 5;
    const priceEurMwh = Math.max(5, Math.round((base * factor + noise) * 100) / 100);
    const priceSekKwh = Math.round((priceEurMwh / 1000) * EUR_TO_SEK * 100) / 100;

    prices.push({
      timestamp: t.toISOString(),
      priceEurMwh,
      priceSekKwh,
    });
  }

  return prices;
}

async function cachePrices(area: string, prices: PricePoint[]): Promise<void> {
  if (prices.length === 0) return;

  const values = prices.map((p) => ({
    priceArea: area,
    timestamp: new Date(p.timestamp),
    priceEurMwh: p.priceEurMwh,
  }));

  for (const val of values) {
    await db
      .insert(energyPricesTable)
      .values(val)
      .onConflictDoUpdate({
        target: [energyPricesTable.priceArea, energyPricesTable.timestamp],
        set: { priceEurMwh: val.priceEurMwh },
      });
  }
}

async function getCachedPrices(area: string, hours: number): Promise<PricePoint[] | null> {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const end = new Date(now.getTime() + hours * 3600000);

  const rows = await db
    .select()
    .from(energyPricesTable)
    .where(
      and(
        eq(energyPricesTable.priceArea, area),
        gte(energyPricesTable.timestamp, now),
        lte(energyPricesTable.timestamp, end)
      )
    )
    .orderBy(asc(energyPricesTable.timestamp));

  if (rows.length < hours * 0.8) return null;

  return rows.map((r) => ({
    timestamp: r.timestamp.toISOString(),
    priceEurMwh: r.priceEurMwh,
    priceSekKwh: Math.round((r.priceEurMwh / 1000) * EUR_TO_SEK * 100) / 100,
  }));
}

export async function getCurrentPrice(area: string): Promise<PricePoint> {
  const prices = await getPrices(area, 1);
  return prices[0];
}

export async function getPrices(area: string, hours: number = 24): Promise<PricePoint[]> {
  const cached = await getCachedPrices(area, hours);
  if (cached && cached.length >= hours * 0.8) return cached;

  const entsoe = await fetchEntsoeSpotPrices(area, hours);
  if (entsoe && entsoe.length > 0) {
    cachePrices(area, entsoe).catch((err) => {
      console.error("Failed to cache ENTSO-E prices:", err);
    });
    return entsoe;
  }

  const prices = generateFallbackPrices(area, hours);

  cachePrices(area, prices).catch((err) => {
    console.error("Failed to cache fallback energy prices:", err);
  });

  return prices;
}

export async function getOptimalChargingWindow(
  area: string,
  durationMin: number,
  deadline: Date
): Promise<ChargingWindow> {
  const now = new Date();
  const hoursUntilDeadline = Math.max(1, Math.ceil((deadline.getTime() - now.getTime()) / 3600000));
  const prices = await getPrices(area, hoursUntilDeadline);

  const windowSlots = Math.ceil(durationMin / 60);
  if (windowSlots >= prices.length) {
    const avgPrice = prices.reduce((s, p) => s + p.priceEurMwh, 0) / prices.length;
    const startTs = new Date(prices[0].timestamp);
    const endTs = new Date(startTs.getTime() + durationMin * 60000);
    return {
      start: prices[0].timestamp,
      end: endTs.toISOString(),
      avgPriceEurMwh: Math.round(avgPrice * 100) / 100,
      avgPriceSekKwh: Math.round((avgPrice / 1000) * EUR_TO_SEK * 100) / 100,
      savingsPercent: 0,
    };
  }

  let bestStart = 0;
  let bestAvg = Infinity;

  for (let i = 0; i <= prices.length - windowSlots; i++) {
    let sum = 0;
    for (let j = i; j < i + windowSlots; j++) {
      sum += prices[j].priceEurMwh;
    }
    const avg = sum / windowSlots;
    if (avg < bestAvg) {
      bestAvg = avg;
      bestStart = i;
    }
  }

  const overallAvg = prices.reduce((s, p) => s + p.priceEurMwh, 0) / prices.length;
  const savingsPercent = overallAvg > 0 ? Math.round(((overallAvg - bestAvg) / overallAvg) * 100) : 0;

  return {
    start: prices[bestStart].timestamp,
    end: new Date(new Date(prices[bestStart].timestamp).getTime() + durationMin * 60000).toISOString(),
    avgPriceEurMwh: Math.round(bestAvg * 100) / 100,
    avgPriceSekKwh: Math.round((bestAvg / 1000) * EUR_TO_SEK * 100) / 100,
    savingsPercent: Math.max(0, savingsPercent),
  };
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function startPriceRefresh() {
  async function refresh() {
    for (const area of ["SE1", "SE2", "SE3", "SE4"]) {
      const entsoe = await fetchEntsoeSpotPrices(area, 48);
      if (entsoe && entsoe.length > 0) {
        await cachePrices(area, entsoe).catch(() => {});
      } else {
        const prices = generateFallbackPrices(area, 48);
        await cachePrices(area, prices).catch(() => {});
      }
    }
  }

  refresh();
  refreshTimer = setInterval(refresh, 6 * 3600 * 1000);
}

export function stopPriceRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
