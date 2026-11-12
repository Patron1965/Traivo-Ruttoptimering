import type { PersistedColumnMapping } from "./import-mapping";

interface MappingField {
  key: string;
  required: boolean;
}

/** Required fields are never included in bulk clearing. */
export function clearSelectedImportMappings(
  mapping: PersistedColumnMapping,
  fields: readonly MappingField[],
  selectedKeys: readonly string[],
): PersistedColumnMapping {
  const selected = new Set(selectedKeys);
  const next = { ...mapping };
  for (const field of fields) {
    if (!field.required && selected.has(field.key)) {
      Object.assign(next, { [field.key]: null });
    }
  }
  return next;
}

/** Restore only explicit skips; never overwrite a later manual mapping. */
export function restoreSelectedImportMappings(
  mapping: PersistedColumnMapping,
  fields: readonly MappingField[],
  selectedKeys: readonly string[],
  previousMapping: PersistedColumnMapping,
  headers: readonly string[],
): PersistedColumnMapping {
  const selected = new Set(selectedKeys);
  const next = { ...mapping };
  for (const field of fields) {
    const column = previousMapping[field.key];
    if (!field.required && selected.has(field.key) && mapping[field.key] === null
      && typeof column === "string" && headers.includes(column)) {
      Object.assign(next, { [field.key]: column });
    }
  }
  return next;
}
