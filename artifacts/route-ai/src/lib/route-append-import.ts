import type { ImportStopsBodyStopsItem, Route } from "@workspace/api-client-react";
import { normalizeImportDate, normalizeImportTime, parseLocalizedNumber, type ParsedImportFile } from "./import-file.ts";
import { stockholmPlanningMinuteToIso } from "./stockholm-planning-time.ts";

export const APPEND_FIELDS = {
  address: "Leveransadress", postalCode: "Postnummer", city: "Ort",
  planningDate: "Datum", externalRef: "Referensnummer",
  contactName: "Kontaktperson", contactPhone: "Telefon", contactEmail: "E-post",
  serviceDurationMin: "Servicetid (min)", timeWindowStart: "Tidsfönster från",
  timeWindowEnd: "Tidsfönster till", weightKg: "Vikt (kg)", volumeM3: "Volym (m³)",
  pickupAddress: "Hämtningsadress", jobType: "Uppdragstyp",
  latitude: "Latitud", longitude: "Longitud", pickupLatitude: "Hämtning latitud", pickupLongitude: "Hämtning longitud",
  notes: "Anteckningar", priority: "Prioritet", slaDeadline: "SLA-tid",
  serviceCategory: "Servicekategori", serviceInstructions: "Serviceinstruktioner",
  requiredSkills: "Kompetenser", requiredCertifications: "Certifieringar", requiredEquipment: "Utrustning",
} as const;
export type AppendField = keyof typeof APPEND_FIELDS;
export type AppendMapping = Partial<Record<AppendField, string>>;

export function canConfirmAppend(state: { busy: boolean; submitted: boolean; duplicates: number; acknowledged: boolean; expiresAt: string }, now = Date.now()): boolean {
  return !state.busy && !state.submitted && (!state.duplicates || state.acknowledged)
    && Date.parse(state.expiresAt) > now;
}

export function canAppendToRoute(route: Pick<Route, "status" | "handoffStatus" | "optimizationFrozen" | "sentAt" | "acceptedAt">): boolean {
  return ["draft", "optimized"].includes(route.status)
    && route.handoffStatus === "pending" && !route.optimizationFrozen && !route.sentAt && !route.acceptedAt;
}

export function assertCompleteAppendFile(file: ParsedImportFile): void {
  if (!file.rows.length || file.rejectedRows.length || file.rows.length !== file.sourceRowCount) {
    throw new Error(`Hela filen avvisades. ${file.rejectedRows.map(row => `Rad ${row.sourceRowNumber}: ${row.reasons.join(" ")}`).join(" ") || "Filen saknar giltiga rader."}`);
  }
}

export function mapAppendRows(file: ParsedImportFile, mapping: AppendMapping, routeDate: string): ImportStopsBodyStopsItem[] {
  assertCompleteAppendFile(file);
  if (!mapping.address) throw new Error("Välj kolumn för leveransadress.");
  const selected = Object.values(mapping).filter(Boolean);
  if (new Set(selected).size !== selected.length) throw new Error("Samma kolumn får inte kopplas till flera fält.");
  return file.rows.map(row => {
    const get = (key: AppendField) => {
      const header = mapping[key];
      if (!header) return "";
      const index = file.headers.indexOf(header);
      if (index < 0) throw new Error(`Kolumnen ${header} saknas.`);
      return row.values[index].trim();
    };
    const fail = (message: string): never => { throw new Error(`Rad ${row.sourceRowNumber}: ${message} Hela filen avvisades.`); };
    if (!get("address")) fail("Leveransadress saknas.");
    const date = get("planningDate") ? normalizeImportDate(get("planningDate")) : routeDate.slice(0, 10);
    if (!date) fail("Ogiltigt datum.");
    if (date !== routeDate.slice(0, 10)) fail("Datumet måste vara samma som ruttens datum.");
    const stop: ImportStopsBodyStopsItem = {
      address: [get("address"), get("postalCode"), get("city")].filter(Boolean).join(", "),
      planningDate: date, sourceRowNumber: row.sourceRowNumber,
      // Preserve every source cell, including mapped columns, with collision-free positional keys.
      customFields: Object.fromEntries(file.headers.map((header, index) => [`Källkolumn ${index + 1}: ${header}`, row.values[index]])),
    };
    const record = stop as Record<string, unknown>;
    for (const field of Object.keys(APPEND_FIELDS) as AppendField[]) {
      const value = get(field);
      if (!value || ["address", "postalCode", "city", "planningDate"].includes(field)) continue;
      if (["serviceDurationMin", "weightKg", "volumeM3", "priority", "latitude", "longitude", "pickupLatitude", "pickupLongitude"].includes(field)) {
        const number = parseLocalizedNumber(value);
        if (number === undefined || (!field.toLowerCase().includes("itude") && number < 0)) fail(`Ogiltigt tal i ${APPEND_FIELDS[field]}.`);
        record[field] = number;
      } else if (["timeWindowStart", "timeWindowEnd", "slaDeadline"].includes(field)) {
        const time = normalizeImportTime(value);
        const iso = time && (time.includes("T") ? time : stockholmPlanningMinuteToIso(`${date}T${time}`));
        if (!iso) fail(`Ogiltig eller tvetydig tid i ${APPEND_FIELDS[field]}.`);
        record[field] = iso;
      } else if (["requiredSkills", "requiredCertifications", "requiredEquipment"].includes(field)) {
        record[field] = value.split(/[,;]/).map(item => item.trim()).filter(Boolean);
      } else if (field === "jobType") {
        if (!["delivery", "pickup_delivery", "field_service"].includes(value)) fail("Ogiltig uppdragstyp.");
        record[field] = value;
      } else record[field] = value;
    }
    if (stop.jobType === "pickup_delivery" && !stop.pickupAddress) fail("Hämtningsadress saknas för hämtning och leverans.");
    if (stop.timeWindowStart && stop.timeWindowEnd && stop.timeWindowEnd <= stop.timeWindowStart) fail("Tidsfönstrets sluttid måste vara efter starttid.");
    return stop;
  });
}
