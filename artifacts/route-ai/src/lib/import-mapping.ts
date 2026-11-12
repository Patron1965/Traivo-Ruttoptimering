import type { DeliveryAddressMappingPart } from "./delivery-address";

export type PersistedColumnMappingValue =
  | string
  | DeliveryAddressMappingPart[]
  | null
  | undefined;

export type PersistedColumnMapping = Record<string, PersistedColumnMappingValue>;

export interface PersistedCustomField {
  key: string;
  labelKey: string;
  required: boolean;
  description: string;
  apiField: string;
  exampleValue: string;
  forMode?: "transport" | "field_service";
}

export interface ImportMappingProfile {
  version: 1;
  mapping: Record<string, string | DeliveryAddressMappingPart[] | null>;
  customFields: PersistedCustomField[];
  /**
   * Source headers that the user explicitly excluded. This is optional so
   * profiles written before skippedColumns was introduced remain valid; the
   * merge helper also repairs these entries from legacy null custom fields.
   */
  skippedColumns?: string[];
}

export type ImportMappingStorageStatus =
  | "ok"
  | "missing"
  | "invalid"
  | "unavailable";

export interface ImportMappingStorageResult {
  status: ImportMappingStorageStatus;
  profile?: ImportMappingProfile;
}

export const IMPORT_MAPPING_STORAGE_PREFIX = "routeai:import-mapping:v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeKey(value: string): boolean {
  return value !== "__proto__" && value !== "constructor" && value !== "prototype";
}

function isAddressComponent(value: unknown): value is DeliveryAddressMappingPart["component"] {
  return value === "address" || value === "postalCode" || value === "city";
}

function validateMappingValue(value: unknown): value is PersistedColumnMappingValue {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.length > 0;
  return Array.isArray(value) && value.every((part) =>
    isRecord(part)
    && isAddressComponent(part.component)
    && typeof part.column === "string"
    && part.column.length > 0,
  );
}

function validateCustomField(value: unknown): value is PersistedCustomField {
  if (!isRecord(value)) return false;
  return (
    typeof value.key === "string"
    && value.key.length > 0
    && isSafeKey(value.key)
    && typeof value.labelKey === "string"
    && typeof value.required === "boolean"
    && typeof value.description === "string"
    && typeof value.apiField === "string"
    && typeof value.exampleValue === "string"
    && (value.forMode === undefined
      || value.forMode === "transport"
      || value.forMode === "field_service")
  );
}

function validateProfile(value: unknown): value is ImportMappingProfile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.mapping)) return false;
  if (!Object.values(value.mapping).every(validateMappingValue)) return false;
  if (!Array.isArray(value.customFields) || !value.customFields.every(validateCustomField)) return false;
  return value.skippedColumns === undefined
    || (
      Array.isArray(value.skippedColumns)
      && value.skippedColumns.every((column) => typeof column === "string" && column.length > 0)
    );
}

function storageFor(storage?: Storage): Storage | undefined {
  if (storage) return storage;
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function importMappingStorageKey(
  organizationId: string,
  userId: string,
): string {
  return `${IMPORT_MAPPING_STORAGE_PREFIX}:${encodeURIComponent(organizationId)}:${encodeURIComponent(userId)}`;
}

/**
 * Read only the user's mapping metadata. Parsed rows and any file data are
 * intentionally not part of this profile.
 */
export function loadImportMappingProfile(
  organizationId: string,
  userId: string,
  storage?: Storage,
): ImportMappingStorageResult {
  const target = storageFor(storage);
  if (!target || !organizationId || !userId) return { status: "unavailable" };

  let raw: string | null;
  try {
    raw = target.getItem(importMappingStorageKey(organizationId, userId));
  } catch {
    return { status: "unavailable" };
  }
  if (raw == null) return { status: "missing" };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!validateProfile(parsed)) return { status: "invalid" };
    const mapping: ImportMappingProfile["mapping"] = {};
    for (const [key, value] of Object.entries(parsed.mapping)) {
      // Do not let a JSON object mutate Object.prototype when copied.
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      if (typeof value === "string" || value === null) {
        mapping[key] = value;
      } else if (Array.isArray(value)) {
        mapping[key] = value.map((part) => ({
          component: part.component,
          column: part.column,
        }));
      }
    }
    return {
      status: "ok",
      profile: {
        version: 1,
        mapping,
        customFields: parsed.customFields.map((field) => ({ ...field })),
        ...(parsed.skippedColumns
          ? { skippedColumns: [...parsed.skippedColumns] }
          : {}),
      },
    };
  } catch {
    return { status: "invalid" };
  }
}

function profileForStorage(
  mapping: PersistedColumnMapping,
  customFields: readonly PersistedCustomField[],
): ImportMappingProfile {
  const persistedMapping: ImportMappingProfile["mapping"] = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (typeof value === "string" && value.length > 0) {
      persistedMapping[key] = value;
    } else if (Array.isArray(value)) {
      persistedMapping[key] = value
        .filter((part) =>
          isAddressComponent(part.component)
          && typeof part.column === "string"
          && part.column.length > 0,
        )
        .map((part) => ({ component: part.component, column: part.column }));
    } else {
      // Saving undefined as null makes an intentional skip durable while
      // keeping the on-disk shape JSON-only.
      persistedMapping[key] = null;
    }
  }
  return {
    version: 1,
    mapping: persistedMapping,
    customFields: customFields
      .filter(validateCustomField)
      .map((field) => ({ ...field })),
    skippedColumns: customFields
      .filter((field) =>
        validateCustomField(field)
        && Object.prototype.hasOwnProperty.call(mapping, field.key)
        && mapping[field.key] === null
        && field.labelKey.length > 0,
      )
      .map((field) => field.labelKey)
      .filter((column, index, columns) => columns.indexOf(column) === index),
  };
}

export function saveImportMappingProfile(
  organizationId: string,
  userId: string,
  mapping: PersistedColumnMapping,
  customFields: readonly PersistedCustomField[],
  storage?: Storage,
): ImportMappingStorageStatus {
  const target = storageFor(storage);
  if (!target || !organizationId || !userId) return "unavailable";
  try {
    target.setItem(
      importMappingStorageKey(organizationId, userId),
      JSON.stringify(profileForStorage(mapping, customFields)),
    );
    return "ok";
  } catch {
    return "unavailable";
  }
}

function columnsInMapping(mapping: PersistedColumnMapping): Set<string> {
  const columns = new Set<string>();
  for (const value of Object.values(mapping)) {
    if (typeof value === "string") columns.add(value);
    if (Array.isArray(value)) {
      for (const part of value) {
        if (typeof part.column === "string") columns.add(part.column);
      }
    }
  }
  return columns;
}

function resolveSavedValue(
  value: PersistedColumnMappingValue,
  headers: readonly string[],
): string | DeliveryAddressMappingPart[] | null {
  if (typeof value === "string") return headers.includes(value) ? value : null;
  if (Array.isArray(value)) {
    return value
      .filter((part) => headers.includes(part.column))
      .map((part) => ({ component: part.component, column: part.column }));
  }
  return null;
}

function withoutUsedColumns(
  value: PersistedColumnMappingValue,
  usedColumns: Set<string>,
): PersistedColumnMappingValue {
  if (typeof value === "string") return usedColumns.has(value) ? null : value;
  if (!Array.isArray(value)) return value;
  return value.filter((part) => !usedColumns.has(part.column));
}

export interface NormalizedGeneratedCustomFields {
  mapping: PersistedColumnMapping;
  customFields: PersistedCustomField[];
}

/**
 * Old import profiles can contain one generated custom field per import
 * generation.  A generated field is identifiable by its exact source label
 * and the canonical key derived from that label (optionally followed by the
 * numeric suffix used when a key was already occupied).
 *
 * A family is only safe to fold when one member has an explicit persisted
 * null (the legacy skip intent) and every member being folded is unset or
 * still mapped to its own source label. A field remapped to another source
 * column is a deliberate choice, even when its key happens to look
 * generated, and must remain untouched.
 */
export function normalizeGeneratedCustomFields(
  mapping: PersistedColumnMapping,
  customFields: readonly PersistedCustomField[],
  normalizeHeader: (header: string) => string,
): NormalizedGeneratedCustomFields {
  const nextMapping: PersistedColumnMapping = {};
  for (const [key, value] of Object.entries(mapping)) {
    nextMapping[key] = Array.isArray(value)
      ? value.map((part) => ({ component: part.component, column: part.column }))
      : value;
  }

  const nextFields: PersistedCustomField[] = [];
  const eligibleFamilies = new Map<string, Array<{
    field: PersistedCustomField;
    value: PersistedColumnMappingValue;
    rank: number;
    hasExplicitNull: boolean;
  }>>();

  for (const field of customFields) {
    const canonical = normalizeHeader(field.labelKey);
    const generatedBase = canonical ? `custom_${canonical}` : "";
    const isGeneratedKey = generatedBase.length > 0
      && (field.key === generatedBase || new RegExp(`^${generatedBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_\\d+$`).test(field.key));
    const hasSavedMapping = Object.prototype.hasOwnProperty.call(mapping, field.key);
    const value = hasSavedMapping ? mapping[field.key] : undefined;
    const isOwnSourceMapping = value === field.labelKey;
    const isEligible = value === null || value === undefined || isOwnSourceMapping;

    if (!isGeneratedKey || !isEligible) {
      continue;
    }

    const familyKey = `${field.labelKey}\u0000${generatedBase}`;
    const family = eligibleFamilies.get(familyKey) ?? [];
    const suffix = field.key === generatedBase
      ? 0
      : Number(field.key.slice(generatedBase.length + 1));
    family.push({
      field,
      value,
      rank: Number.isFinite(suffix) ? suffix : Number.MAX_SAFE_INTEGER,
      hasExplicitNull: hasSavedMapping && value === null,
    });
    eligibleFamilies.set(familyKey, family);
  }

  const collapsedFamilies = new Map<string, Array<{
    field: PersistedCustomField;
    value: PersistedColumnMappingValue;
    rank: number;
    hasExplicitNull: boolean;
  }>>();
  for (const family of eligibleFamilies.values()) {
    family.sort((left, right) => left.rank - right.rank);
    const canonicalField = family[0];
    if (!canonicalField) continue;
    if (family.length === 1 || !family.some(({ hasExplicitNull }) => hasExplicitNull)) {
      // A lone custom_<normalized-label> field may be a legitimate field
      // created by the user; it is not evidence of a duplicated generation.
      // Likewise, an all-mapped (or merely unconfigured) family has no
      // explicit skip to repair and must remain exactly as configured.
      continue;
    }
    collapsedFamilies.set(canonicalField.field.key, family);
    // The explicit null that triggered this family is an explicit skip. Do
    // not let a later auto-mapped copy resurrect that source column.
    nextMapping[canonicalField.field.key] = family.some(({ value }) => value === null || value === undefined)
      ? null
      : canonicalField.value;
    for (const { field } of family.slice(1)) delete nextMapping[field.key];
  }

  const emittedFamilies = new Set<string>();
  for (const field of customFields) {
    const family = [...collapsedFamilies.values()].find((members) =>
      members.some(({ field: member }) => member.key === field.key),
    );
    if (!family) {
      nextFields.push({ ...field });
      continue;
    }
    const canonicalKey = family[0]?.field.key;
    if (canonicalKey && !emittedFamilies.has(canonicalKey) && field.key === canonicalKey) {
      nextFields.push({ ...field });
      emittedFamilies.add(canonicalKey);
    }
  }

  return { mapping: nextMapping, customFields: nextFields };
}

/**
 * Drafts that already have an import result (or persisted stop projections)
 * are frozen data, not mapping metadata.  Keep those drafts byte-for-byte
 * intact while repairing only resumable, pre-import wizard state.
 */
export function normalizePreImportDraftMapping(
  state: {
    mapping?: PersistedColumnMapping;
    customFields?: readonly PersistedCustomField[];
    importedResult?: unknown;
    importedStopIds?: readonly unknown[];
    savedStops?: readonly unknown[];
  },
  normalizeHeader: (header: string) => string,
): NormalizedGeneratedCustomFields | null {
  if (
    state.importedResult != null
    || (state.importedStopIds?.length ?? 0) > 0
    || (state.savedStops?.length ?? 0) > 0
    || !state.mapping
    || !state.customFields
  ) {
    return null;
  }
  return normalizeGeneratedCustomFields(state.mapping, state.customFields, normalizeHeader);
}

/**
 * A null mapping for a generated custom field is the legacy representation of
 * "skip this source column". It must be matched by the exact header, rather
 * than by its normalized key, so similarly named columns remain independent.
 */
function explicitlySkippedColumns(
  profile: ImportMappingProfile | undefined,
  headers: readonly string[],
  mappedColumns: Set<string>,
): Set<string> {
  const skipped = new Set<string>();
  for (const column of profile?.skippedColumns ?? []) {
    if (headers.includes(column)) skipped.add(column);
  }

  for (const field of profile?.customFields ?? []) {
    const hasSavedMapping = profile?.mapping != null
      && Object.prototype.hasOwnProperty.call(profile.mapping, field.key);
    const savedValue = hasSavedMapping ? profile.mapping[field.key] : undefined;
    const hasSavedNull = hasSavedMapping && savedValue === null;
    if (hasSavedNull && headers.includes(field.labelKey)) {
      skipped.add(field.labelKey);
    } else if (hasSavedMapping && savedValue !== null && savedValue !== undefined) {
      // A stale optional skippedColumns entry must not hide a label after its
      // custom field was deliberately remapped to another source column.
      skipped.delete(field.labelKey);
    }
  }

  // A deliberate remap wins over a stale skip entry, including entries from
  // profiles written before skippedColumns existed.
  for (const column of mappedColumns) skipped.delete(column);
  // If a duplicate generation included an explicit null, that skip intent
  // wins over a different-source remap of the redundant copy. A system
  // mapping of the exact source header still wins via mappedColumns above.
  for (const field of profile?.customFields ?? []) {
    const hasSavedMapping = profile?.mapping != null
      && Object.prototype.hasOwnProperty.call(profile.mapping, field.key);
    if (
      hasSavedMapping
      && profile?.mapping[field.key] === null
      && headers.includes(field.labelKey)
      && !mappedColumns.has(field.labelKey)
    ) {
      skipped.add(field.labelKey);
    }
  }
  return skipped;
}

export interface MergeSavedImportMappingOptions {
  headers: readonly string[];
  fallbackMapping: PersistedColumnMapping;
  savedProfile?: ImportMappingProfile;
  systemFieldKeys: readonly string[];
  normalizeHeader: (header: string) => string;
}

export interface MergeSavedImportMappingResult {
  mapping: PersistedColumnMapping;
  customFields: PersistedCustomField[];
  matchedHeaders: Set<string>;
}

/**
 * Reuse exact saved columns, then auto-match only fields that have never been
 * configured. A saved null is an explicit exclusion and therefore blocks an
 * alias suggestion until the user changes it in the mapping UI.
 */
export function mergeSavedImportMapping({
  headers,
  fallbackMapping,
  savedProfile,
  systemFieldKeys,
  normalizeHeader,
}: MergeSavedImportMappingOptions): MergeSavedImportMappingResult {
  const normalizedSaved = savedProfile
    ? normalizeGeneratedCustomFields(
      savedProfile.mapping,
      savedProfile.customFields,
      normalizeHeader,
    )
    : null;
  const normalizedProfile = savedProfile && normalizedSaved
    ? {
      ...savedProfile,
      mapping: normalizedSaved.mapping as ImportMappingProfile["mapping"],
      customFields: normalizedSaved.customFields,
    }
    : savedProfile;
  const savedMapping = normalizedProfile?.mapping ?? {};
  const savedKeys = new Set(Object.keys(savedMapping));
  const resolvedSavedMapping: PersistedColumnMapping = {};
  for (const [key, value] of Object.entries(savedMapping)) {
    resolvedSavedMapping[key] = resolveSavedValue(value, headers);
  }
  const savedColumns = columnsInMapping(resolvedSavedMapping);
  const skippedColumns = explicitlySkippedColumns(normalizedProfile, headers, savedColumns);
  const reservedColumns = new Set([...savedColumns, ...skippedColumns]);
  const mapping: PersistedColumnMapping = {};
  for (const [key, value] of Object.entries(fallbackMapping)) {
    mapping[key] = savedKeys.has(key)
      ? null
      : withoutUsedColumns(value, reservedColumns);
  }
  for (const [key, value] of Object.entries(resolvedSavedMapping)) {
    mapping[key] = value;
  }

  const systemKeys = new Set(systemFieldKeys);
  const customFields: PersistedCustomField[] = [];
  const usedCustomKeys = new Set<string>(systemFieldKeys);
  for (const field of normalizedProfile?.customFields ?? []) {
    if (!isSafeKey(field.key) || systemKeys.has(field.key) || usedCustomKeys.has(field.key)) continue;
    usedCustomKeys.add(field.key);
    customFields.push({ ...field });
    if (!Object.prototype.hasOwnProperty.call(mapping, field.key)) {
      mapping[field.key] = null;
    }
  }

  const matchedHeaders = columnsInMapping(mapping);
  for (const header of skippedColumns) matchedHeaders.add(header);
  const unknownHeaders = headers.filter((header) => !matchedHeaders.has(header));
  unknownHeaders.forEach((header, index) => {
    const base = `custom_${normalizeHeader(header) || `kolumn_${index + 1}`}`;
    let key = base;
    let suffix = 2;
    while (usedCustomKeys.has(key)) {
      key = `${base}_${suffix}`;
      suffix += 1;
    }
    usedCustomKeys.add(key);
    customFields.push({
      key,
      labelKey: header,
      required: false,
      description: "",
      apiField: key,
      exampleValue: "",
    });
    mapping[key] = header;
    matchedHeaders.add(header);
  });

  return { mapping, customFields, matchedHeaders };
}