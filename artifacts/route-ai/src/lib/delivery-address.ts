/**
 * Mapping and formatting helpers for delivery addresses.
 *
 * A mapping saved by older drafts uses a string for each system field.  Newer
 * drafts may use an ordered list for the delivery-address target so that one
 * target can be composed from street, postcode and locality columns.  Keep
 * this module tolerant of both shapes; drafts are user data and must remain
 * resumable after the mapping UI changes.
 */

export type DeliveryAddressComponent = "address" | "postalCode" | "city";

export interface DeliveryAddressMappingPart {
  component: DeliveryAddressComponent;
  column: string;
}

export type DeliveryAddressMappingValue =
  | string
  | DeliveryAddressMappingPart[]
  | null
  | undefined;

export interface DeliveryAddressMappingSource {
  address?: DeliveryAddressMappingValue;
  postalCode?: DeliveryAddressMappingValue;
  city?: DeliveryAddressMappingValue;
}

export interface DeliveryAddressValues {
  address: string;
  postalCode?: string;
  city?: string;
  composed: boolean;
}

const COMPONENT_ORDER: readonly DeliveryAddressComponent[] = [
  "address",
  "postalCode",
  "city",
];

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isComponent(value: unknown): value is DeliveryAddressComponent {
  return value === "address" || value === "postalCode" || value === "city";
}

function isPart(value: unknown): value is DeliveryAddressMappingPart {
  return (
    typeof value === "object"
    && value !== null
    && isComponent((value as { component?: unknown }).component)
    && typeof (value as { column?: unknown }).column === "string"
    && clean((value as { column: string }).column).length > 0
  );
}

function partForLegacyValue(
  component: DeliveryAddressComponent,
  value: DeliveryAddressMappingValue,
): DeliveryAddressMappingPart | null {
  const column = clean(value);
  return column ? { component, column } : null;
}

/**
 * Returns the ordered source columns for the delivery-address target.
 *
 * For a legacy string mapping, postcode and locality mappings are folded into
 * the same target.  This is only a view of the mapping; callers that edit it
 * should save an explicit parts array so removing a chip cannot be undone by
 * the legacy fields on the next render.
 */
export function getDeliveryAddressMapping(
  mapping: DeliveryAddressMappingSource,
): DeliveryAddressMappingPart[] {
  const configured = mapping.address;
  const parts: DeliveryAddressMappingPart[] = Array.isArray(configured)
    ? configured.filter(isPart).map((part) => ({
      component: part.component,
      column: clean(part.column),
    }))
    : [partForLegacyValue("address", configured)].filter(
      (part): part is DeliveryAddressMappingPart => part !== null,
    );

  if (!Array.isArray(configured)) {
    for (const component of ["postalCode", "city"] as const) {
      const part = partForLegacyValue(component, mapping[component]);
      if (part) parts.push(part);
    }
  }

  // A source column can be accidentally selected for two chips.  Keeping its
  // first occurrence makes the composed address deterministic and prevents a
  // duplicated postcode/locality in the persisted stop.
  const usedColumns = new Set<string>();
  const usedComponents = new Set<DeliveryAddressComponent>();
  return parts
    .filter((part) => {
      if (usedColumns.has(part.column) || usedComponents.has(part.component)) return false;
      usedColumns.add(part.column);
      usedComponents.add(part.component);
      return true;
    })
    .sort((left, right) =>
      COMPONENT_ORDER.indexOf(left.component) - COMPONENT_ORDER.indexOf(right.component));
}

function valueForColumn(
  row: readonly string[],
  headers: readonly string[],
  column: string,
): string {
  const index = headers.indexOf(column);
  return index >= 0 ? clean(row[index]) : "";
}

/**
 * Resolves the address target against one parsed source row.  Values are
 * intentionally returned as strings: postcodes are identifiers, not numbers,
 * so leading zeroes must survive the import unchanged.
 */
export function resolveDeliveryAddressValues(
  mapping: DeliveryAddressMappingSource,
  headers: readonly string[],
  row: readonly string[],
): DeliveryAddressValues {
  const parts = getDeliveryAddressMapping(mapping);
  const values = new Map<DeliveryAddressComponent, string>();

  for (const part of parts) {
    const value = valueForColumn(row, headers, part.column);
    if (value && !values.has(part.component)) values.set(part.component, value);
  }

  return {
    address: values.get("address") ?? "",
    postalCode: values.get("postalCode") || undefined,
    city: values.get("city") || undefined,
    composed: Array.isArray(mapping.address),
  };
}

function comparable(value: string): string {
  return value
    .toLocaleLowerCase("sv-SE")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

function hasPostcode(address: string, postalCode: string): boolean {
  const requested = digits(postalCode);
  return requested.length > 0 && digits(address).includes(requested);
}

function hasCity(address: string, city: string): boolean {
  const normalizedAddress = comparable(address);
  const normalizedCity = comparable(city);
  return Boolean(
    normalizedCity
    && (
      normalizedAddress === normalizedCity
      || normalizedAddress.startsWith(`${normalizedCity} `)
      || normalizedAddress.includes(` ${normalizedCity} `)
      || normalizedAddress.endsWith(` ${normalizedCity}`)
    ),
  );
}

/**
 * Joins an address with optional structured components without duplicating
 * postcode or city already present in a complete-address source cell.
 *
 * Composed mappings use a single space between ordered components to preserve
 * the import preview shape (for example "AKTERGATAN 12 LGH 1002 12066
 * STOCKHOLM").  Legacy complete-address mappings retain the existing comma
 * separator used by imported stops.
 */
export function composeDeliveryAddress(
  address: string | undefined,
  postalCode: string | undefined,
  city: string | undefined,
  options: { composed?: boolean } = {},
): string {
  const street = clean(address);
  const postal = clean(postalCode);
  const locality = clean(city);
  const parts = [street];

  if (postal && !hasPostcode(street, postal)) parts.push(postal);
  if (locality && !hasCity(street, locality)) parts.push(locality);

  return parts
    .filter(Boolean)
    .join(options.composed ? " " : ", ");
}

export function deliveryAddressPreview(
  mapping: DeliveryAddressMappingSource,
  headers: readonly string[],
  row: readonly string[] | undefined,
): string {
  if (!row) return "";
  const values = resolveDeliveryAddressValues(mapping, headers, row);
  return composeDeliveryAddress(values.address, values.postalCode, values.city, {
    composed: values.composed,
  });
}