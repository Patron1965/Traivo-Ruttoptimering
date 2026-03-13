import { DEPOT_LOCATION } from "./constants";

const AVERAGE_SPEED_KMH = 30;

export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface ScheduledStop {
  stopId: string;
  address: string;
  customerName?: string;
  latitude: number;
  longitude: number;
  sequenceOrder: number;
  weightKg: number;
  volumeM3: number;
  serviceDurationMin: number;
  timeWindowStart?: string | null;
  timeWindowEnd?: string | null;
  status: string;
  trackingCode?: string | null;
  notes?: string | null;
  arrivalTime: Date;
  departureTime: Date;
  travelTimeMin: number;
  distanceFromPrevKm: number;
}

export interface ScheduledRow {
  routeId: string;
  routeName: string;
  driverId?: string | null;
  driverName: string;
  vehicleId: string;
  vehicleName: string;
  vehicleType: string;
  capacityKg: number;
  capacityVolume: number;
  totalWeightKg: number;
  totalVolumeM3: number;
  capacityPercent: number;
  color: string;
  stops: ScheduledStop[];
}

export function computeSchedule(
  stops: Array<{
    id: string;
    address: string;
    latitude: number;
    longitude: number;
    sequenceOrder?: number | null;
    weightKg?: number | null;
    volumeM3?: number | null;
    serviceDurationMin?: number | null;
    timeWindowStart?: string | null;
    timeWindowEnd?: string | null;
    status: string;
    trackingCode?: string | null;
    notes?: string | null;
    customerId?: string | null;
  }>,
  routeDate: string,
): ScheduledStop[] {
  const sorted = [...stops].sort(
    (a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0),
  );

  const baseTime = new Date(routeDate);
  if (baseTime.getHours() === 0 && baseTime.getMinutes() === 0) {
    baseTime.setHours(7, 0, 0, 0);
  }

  let prevLat = DEPOT_LOCATION.lat;
  let prevLng = DEPOT_LOCATION.lng;
  let currentTime = new Date(baseTime);

  return sorted.map((stop, idx) => {
    const distKm = haversineKm(prevLat, prevLng, stop.latitude, stop.longitude);
    const travelMin = (distKm / AVERAGE_SPEED_KMH) * 60;

    const arrivalTime = new Date(currentTime.getTime() + travelMin * 60000);

    if (stop.timeWindowStart) {
      const windowStart = new Date(stop.timeWindowStart);
      if (arrivalTime < windowStart) {
        arrivalTime.setTime(windowStart.getTime());
      }
    }

    const serviceDur = stop.serviceDurationMin ?? 15;
    const departureTime = new Date(
      arrivalTime.getTime() + serviceDur * 60000,
    );

    prevLat = stop.latitude;
    prevLng = stop.longitude;
    currentTime = new Date(departureTime);

    return {
      stopId: stop.id,
      address: stop.address,
      customerName: stop.address.split(",")[0] || undefined,
      latitude: stop.latitude,
      longitude: stop.longitude,
      sequenceOrder: idx + 1,
      weightKg: stop.weightKg ?? 0,
      volumeM3: stop.volumeM3 ?? 0,
      serviceDurationMin: serviceDur,
      timeWindowStart: stop.timeWindowStart,
      timeWindowEnd: stop.timeWindowEnd,
      status: stop.status,
      trackingCode: stop.trackingCode,
      notes: stop.notes,
      arrivalTime,
      departureTime,
      travelTimeMin: Math.round(travelMin * 10) / 10,
      distanceFromPrevKm: Math.round(distKm * 100) / 100,
    };
  });
}
