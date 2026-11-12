const SPEED_PROFILES: { start: number; end: number; speedKmh: number }[] = [
  { start: 0, end: 6, speedKmh: 50 },
  { start: 6, end: 7, speedKmh: 35 },
  { start: 7, end: 9, speedKmh: 20 },
  { start: 9, end: 16, speedKmh: 35 },
  { start: 16, end: 18, speedKmh: 20 },
  { start: 18, end: 21, speedKmh: 35 },
  { start: 21, end: 24, speedKmh: 50 },
];

const DEFAULT_SERVICE_DURATION_MIN = 15;

export function getSpeedForTime(date: Date): number {
  const hour = date.getHours() + date.getMinutes() / 60;
  const profile = SPEED_PROFILES.find((p) => hour >= p.start && hour < p.end);
  return profile ? profile.speedKmh : 35;
}

export function estimateDurationMinPredictive(
  distanceKm: number,
  departureTime: Date
): number {
  if (distanceKm <= 0) return 0;

  let remainingKm = distanceKm;
  let totalMinutes = 0;
  const currentTime = new Date(departureTime);

  while (remainingKm > 0) {
    const speed = getSpeedForTime(currentTime);
    const hourFraction = currentTime.getMinutes() / 60;
    const currentHour = currentTime.getHours() + hourFraction;

    const currentProfile = SPEED_PROFILES.find(
      (p) => currentHour >= p.start && currentHour < p.end
    );
    const minutesUntilProfileChange = currentProfile
      ? (currentProfile.end - currentHour) * 60
      : 60;

    const kmInThisSegment = (speed / 60) * minutesUntilProfileChange;

    if (remainingKm <= kmInThisSegment) {
      const minutesNeeded = (remainingKm / speed) * 60;
      totalMinutes += minutesNeeded;
      remainingKm = 0;
    } else {
      totalMinutes += minutesUntilProfileChange;
      remainingKm -= kmInThisSegment;
      currentTime.setMinutes(currentTime.getMinutes() + minutesUntilProfileChange);
    }
  }

  return Math.round(totalMinutes * 10) / 10;
}

export function getAdjustedServiceDuration(
  baseDurationMin: number | null | undefined,
  historicalDurations?: number[]
): number {
  const base = baseDurationMin || DEFAULT_SERVICE_DURATION_MIN;

  if (!historicalDurations || historicalDurations.length === 0) {
    return base;
  }

  const recentWeight = 0.7;
  const baseWeight = 0.3;

  const avgHistorical =
    historicalDurations.reduce((sum, d) => sum + d, 0) /
    historicalDurations.length;

  return Math.round((avgHistorical * recentWeight + base * baseWeight) * 10) / 10;
}

export function getTrafficDescription(date: Date): string {
  const speed = getSpeedForTime(date);
  if (speed <= 20) return "heavy";
  if (speed <= 35) return "normal";
  return "light";
}
