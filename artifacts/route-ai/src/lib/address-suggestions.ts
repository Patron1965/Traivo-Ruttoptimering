export type AddressSuggestion = {
  id: string;
  displayName: string;
  value: string;
  verified: boolean;
};

export type PersistedVerifiedAddress = {
  value: string;
  latitude: number;
  longitude: number;
};

export type GeocodeResponse = {
  displayName?: string;
  candidates?: Array<{ id: string; displayName: string }>;
};

/**
 * A stored address is trusted by the fleet editor only when it came back from
 * the server with both coordinates. An address-shaped string on its own is
 * not evidence that the provider verified it.
 */
export function getPersistedVerifiedAddress(
  value: string | null | undefined,
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): PersistedVerifiedAddress | null {
  const normalizedValue = value?.trim() ?? "";
  if (
    !normalizedValue
    || !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
    || latitude! < -90
    || latitude! > 90
    || longitude! < -180
    || longitude! > 180
  ) {
    return null;
  }
  return {
    value: normalizedValue,
    latitude: latitude!,
    longitude: longitude!,
  };
}

/**
 * Provider display names are normally the best canonical value, but an old
 * provider response can omit the house number. Never replace an address
 * containing a house number with that broader display text: retaining the
 * query is the safe composition in that case. A partial candidate, on the
 * other hand, needs to be visible in the input when selected.
 */
function houseNumber(value: string): string | null {
  const streetPart = value.includes(",") ? value.slice(0, value.indexOf(",")) : value;
  const matches = [...streetPart.matchAll(/\b(\d+[a-zA-Z]?(?:[-/]\d+[a-zA-Z]?)?)\b/g)]
    .map((match) => ({ value: match[1], index: match.index ?? 0 }))
    // A compact five digit postcode is not a house number when the input was
    // supplied without commas (for example, "Stockholm 11825 Storgatan 48").
    .filter((match) => !/^\d{5}$/.test(match.value));
  const apartmentMarker = /\b(?:lgh|apt|apartment|lägenhet)\b/i.exec(streetPart)?.index;
  const streetMatches = apartmentMarker === undefined
    ? matches
    : matches.filter((match) => match.index < apartmentMarker);
  return streetMatches.at(-1)?.value.toLocaleLowerCase("sv-SE") ?? null;
}

function canonicalVerifiedAddress(query: string, displayName: string): string {
  const normalizedQuery = query.trim();
  const normalizedDisplayName = displayName.trim();
  const requestedHouse = houseNumber(normalizedQuery);
  const displayedHouse = houseNumber(normalizedDisplayName);

  return requestedHouse && requestedHouse === displayedHouse
    ? normalizedDisplayName
    : normalizedQuery;
}

export function selectedAddressValue(suggestion: AddressSuggestion): string {
  return suggestion.verified ? suggestion.value : suggestion.displayName;
}

export function addressSuggestions(ok: boolean, body: GeocodeResponse, query: string): AddressSuggestion[] {
  // Use the provider's canonical address only when it retains the requested
  // house number. Otherwise keep the original query so selecting GREEN never
  // loses address-level evidence through a broader provider display name.
  if (ok && body.displayName) {
    const canonical = canonicalVerifiedAddress(query, body.displayName);
    return [{ id: canonical, displayName: canonical, value: canonical, verified: true }];
  }
  return (body.candidates ?? []).map((candidate) => ({
    ...candidate,
    // Partial candidates are intentionally not promoted to verified values.
    // Their provider text is useful input for the dispatcher to complete.
    value: query,
    verified: false,
  }));
}