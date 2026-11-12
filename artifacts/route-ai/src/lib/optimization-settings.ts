const fields = [
  "autoBalance", "snapToRoad", "defaultRouteType", "defaultServiceDurationMin",
  "maxDriverOvertimeMin", "allowLateStopsMin",
] as const;

/** Never replay unrelated settings returned by the shared settings GET. */
export function optimizationSettingsPayload<T extends object>(settings: T): Partial<T> {
  return Object.fromEntries(fields
    .filter((field) => Object.hasOwn(settings, field))
    .map((field) => [field, (settings as Record<string, unknown>)[field]])) as Partial<T>;
}
