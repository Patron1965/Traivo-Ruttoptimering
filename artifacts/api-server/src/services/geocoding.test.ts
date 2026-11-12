import assert from "node:assert/strict";
import test from "node:test";
import { geocodeDetailed, normalizeGeocodeInput } from "./geocoding";

const originalFetch = globalThis.fetch;
const originalGoogleKey = process.env.GOOGLE_MAPS_API_KEY;
const originalGeocodingTimeout = process.env.GEOCODING_FETCH_TIMEOUT_MS;

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function googleExact(
  formattedAddress: string,
  latitude: number,
  longitude: number,
  street: string,
  houseNumber: string,
  postalCode?: string,
  locality = "Stockholm",
  partialMatch = false,
  sublocality?: string,
): unknown {
  return {
    status: "OK",
    results: [{
      place_id: `google-${houseNumber}-${postalCode ?? "no-postcode"}`,
      formatted_address: formattedAddress,
      partial_match: partialMatch,
      types: ["street_address"],
      address_components: [
        { long_name: street, types: ["route"] },
        { long_name: houseNumber, types: ["street_number"] },
        ...(postalCode ? [{ long_name: postalCode, types: ["postal_code"] }] : []),
        { long_name: locality, types: ["postal_town"] },
        ...(sublocality ? [{ long_name: sublocality, types: ["sublocality"] }] : []),
      ],
      geometry: { location: { lat: latitude, lng: longitude } },
    }],
  };
}

function googleArea(
  locality: string,
  latitude: number,
  longitude: number,
  bounds?: { northeast: { lat: number; lng: number }; southwest: { lat: number; lng: number } },
  postalCode?: string,
  types = ["sublocality_level_1", "sublocality", "political"],
): unknown {
  return {
    status: "OK",
    results: [{
      formatted_address: `${locality}, Sweden`,
      types,
      address_components: [
        { long_name: locality, types: types.filter((type) => type !== "political") },
        ...(postalCode ? [{ long_name: postalCode, types: ["postal_code"] }] : []),
      ],
      geometry: {
        location: { lat: latitude, lng: longitude },
        ...(bounds ? { bounds } : {}),
      },
    }],
  };
}

function nominatimExact(
  displayName: string,
  latitude: string,
  longitude: string,
  street: string,
  houseNumber: string,
  postcode?: string,
  locality = "Stockholm",
): unknown {
  return [{
    place_id: 123,
    lat: latitude,
    lon: longitude,
    display_name: displayName,
    addresstype: "house",
    address: {
      road: street,
      house_number: houseNumber,
      ...(postcode ? { postcode } : {}),
      city: locality,
    },
  }];
}

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalGoogleKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = originalGoogleKey;
  if (originalGeocodingTimeout === undefined) delete process.env.GEOCODING_FETCH_TIMEOUT_MS;
  else process.env.GEOCODING_FETCH_TIMEOUT_MS = originalGeocodingTimeout;
});

test("normalizes Swedish postcodes without duplicating address locality", () => {
  assert.equal(
    normalizeGeocodeInput({ address: " Storgatan 1, 111 22 Stockholm ", postalCode: "11122", city: "Stockholm" }),
    "Storgatan 1, 111 22 Stockholm",
  );
  assert.equal(
    normalizeGeocodeInput({ address: "Storgatan 1, 11122 Stockholm", postalCode: "111 22", city: "Stockholm" }),
    "Storgatan 1, 111 22 Stockholm",
  );
  assert.equal(
    normalizeGeocodeInput({ address: "Spånga Stationsplan 3", postalCode: "16351", city: "Spånga" }),
    "Spånga Stationsplan 3, 163 51, Spånga",
  );
});

test("normalizes city-postcode-street and street-first Swedish layouts", () => {
  assert.equal(
    normalizeGeocodeInput("Stockholm 11825 Bastugatan 48"),
    "Bastugatan 48, 118 25 Stockholm",
  );
  assert.equal(
    normalizeGeocodeInput("Stockholm 11822 Brännkyrkagatan 47"),
    "Brännkyrkagatan 47, 118 22 Stockholm",
  );
  assert.equal(
    normalizeGeocodeInput("Bastugatan 48 11825 Stockholm"),
    "Bastugatan 48, 118 25 Stockholm",
  );
});

test("keeps an imported apartment unit out of house-number evidence", () => {
  const imported = {
    address: "AKTERGATAN 12 LGH 1002",
    postalCode: "12066",
    city: "Stockholm",
    unit: "1002",
  };
  assert.equal(
    normalizeGeocodeInput(imported),
    "AKTERGATAN 12, 120 66, Stockholm",
  );
  // Normalizing a provider query must not rewrite the imported address or
  // discard the unit metadata kept by the import workflow.
  assert.equal(imported.address, "AKTERGATAN 12 LGH 1002");
  assert.equal(imported.unit, "1002");
});

test("accepts a unique exact street and house when the provider omits apartment unit", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  let requestedQuery = "";
  globalThis.fetch = async (url) => {
    requestedQuery = new URL(String(url)).searchParams.get("address") ?? "";
    return response(200, googleExact(
      "Aktergatan 12, 120 66 Stockholm, Sweden",
      59.281,
      18.011,
      "Aktergatan",
      "12",
      "120 66",
      "Stockholm",
      true,
    ));
  };

  const result = await geocodeDetailed({
    address: "AKTERGATAN 12 LGH 1002",
    postalCode: "12066",
    city: "Stockholm",
    unit: "1002",
  });

  assert.equal(requestedQuery, "AKTERGATAN 12, 120 66, Stockholm");
  assert.equal(result.status, "matched");
  assert.equal(result.result?.latitude, 59.281);
});

test("does not mistake an apartment unit for a provider house number", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async (url) => {
    const query = new URL(String(url)).searchParams.get("address") ?? "";
    return response(200, googleExact(
      "Aktergatan 1002, 120 67 Stockholm, Sweden",
      59.282,
      18.012,
      "Aktergatan",
      "1002",
      "120 67",
      "Stockholm",
    ));
  };

  const result = await geocodeDetailed({
    address: "Aktergatan 12 LGH1002",
    postalCode: "12067",
    city: "Stockholm",
  });

  assert.equal(result.status, "candidates");
  assert.equal(result.result, null);
  assert.equal(result.candidates[0]?.partial, true);
});

test("verifies street number and locality without requiring a comma or postcode", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async () => response(200, googleExact(
    "Högsätravägen 4D, 181 58 Lidingö, Sweden",
    59.3509023, 18.1531034, "Högsätravägen", "4D", "181 58", "Lidingö",
  ));
  assert.equal(normalizeGeocodeInput("Högsätravägen 4D Lidingö"), "Högsätravägen 4D, Lidingö");
  const result = await geocodeDetailed("Högsätravägen 4D Lidingö");
  assert.equal(result.status, "matched");
  assert.equal(result.result?.latitude, 59.3509023);
  for (const input of [
    "Högsätravägen 4E Lidingö", "Högsätravägen 4D Kiruna", "Annanvägen 4D Lidingö",
  ]) {
    assert.notEqual((await geocodeDetailed(input)).status, "matched", input);
  }
});

test("round-trips compact canonical addresses without treating Sweden as locality", async () => {
  const canonical = "Bergtallsvägen6,12559Älvsjö,Sweden";
  assert.equal(
    normalizeGeocodeInput(canonical),
    "Bergtallsvägen 6, 125 59 Älvsjö, Sweden",
  );

  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async () => response(200, googleExact(
    "Bergtallsvägen 6, 125 59 Älvsjö, Sweden",
    59.275,
    18.015,
    "Bergtallsvägen",
    "6",
    "125 59",
    "Älvsjö",
    true,
  ));
  const result = await geocodeDetailed(canonical);
  assert.equal(result.status, "matched");
  assert.equal(result.result?.longitude, 18.015);
});

test("keeps a broad canonical provider result selectable instead of auto-accepting it", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async () => response(200, {
    status: "OK",
    results: [{
      place_id: "bergtallsvagen-route",
      formatted_address: "Bergtallsvägen, Älvsjö, Sweden",
      types: ["route"],
      geometry: { location: { lat: 59.27, lng: 18.01 } },
    }],
  });

  const result = await geocodeDetailed("Bergtallsvägen6,12560Älvsjö,Sweden");
  assert.equal(result.status, "candidates");
  assert.equal(result.result, null);
  assert.equal(result.candidates[0]?.partial, true);
});

test("accepts a unique address-level Google result even when partial_match is true", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  const queries: string[] = [];
  globalThis.fetch = async (url) => {
    const query = new URL(String(url)).searchParams.get("address") ?? "";
    queries.push(query);
    if (query.startsWith("Bastugatan")) {
      return response(200, googleExact(
        "Bastugatan 48, 118 25 Stockholm, Sweden",
        59.318,
        18.057,
        "Bastugatan",
        "48",
        "118 25",
        "Stockholm",
        true,
      ));
    }
    return response(200, googleExact(
      "Brännkyrkagatan 47, 118 22 Stockholm, Sweden",
      59.310,
      18.061,
      "Brännkyrkagatan",
      "47",
      "118 22",
      "Stockholm",
      true,
    ));
  };

  const bastugatan = await geocodeDetailed("Stockholm 11825 Bastugatan 48");
  const brannkyrkagatan = await geocodeDetailed("Stockholm 11822 Brännkyrkagatan 47");

  assert.equal(bastugatan.status, "matched");
  assert.equal(bastugatan.result?.displayName, "Bastugatan 48, 118 25 Stockholm, Sweden");
  assert.equal(brannkyrkagatan.status, "matched");
  assert.equal(brannkyrkagatan.result?.displayName, "Brännkyrkagatan 47, 118 22 Stockholm, Sweden");
  assert.deepEqual(queries, [
    "Bastugatan 48, 118 25 Stockholm",
    "Brännkyrkagatan 47, 118 22 Stockholm",
  ]);
});

test("accepts a unique building in the requested locality despite a different postcode", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const building = googleExact(
      "Norra Härgusseröd 137, 444 94 Ucklum, Sweden",
      58.075, 11.945, "Norra Härgusseröd", "137", "444 94", "Ucklum", true,
    ) as { results: unknown[] };
    const postcode = googleArea("Göteborg", 57.7, 11.97, undefined, "411 33", ["postal_code"]) as { results: unknown[] };
    return response(200, { status: "OK", results: [...building.results, ...postcode.results] });
  };

  const result = await geocodeDetailed({
    address: "Norra Härgusseröd 137", postalCode: "41133", city: "Ucklum",
  });

  assert.equal(result.status, "matched");
  assert.equal(result.query, "Norra Härgusseröd 137, 411 33, Ucklum");
  assert.equal(result.result?.displayName, "Norra Härgusseröd 137, 444 94 Ucklum, Sweden");
  assert.equal(result.result?.latitude, 58.075);
  assert.equal(result.result?.provider, "google");
  assert.equal(calls, 1, "a verified building must not trigger fallback searches");
});

test("accepts a unique Nominatim building despite a different postcode", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async (url) => String(url).includes("maps.googleapis.com")
    ? response(200, { status: "ZERO_RESULTS", results: [] })
    : response(200, nominatimExact(
      "Testpostvägen 19, 444 94 Ucklum", "58.076", "11.946",
      "Testpostvägen", "19", "44494", "Ucklum",
    ));

  const result = await geocodeDetailed({
    address: "Testpostvägen 19", postalCode: "41134", city: "Ucklum",
  });
  assert.equal(result.status, "matched");
  assert.equal(result.result?.provider, "nominatim");
  assert.equal(result.result?.latitude, 58.076);
});

test("keeps multiple qualifying buildings manual even when only one postcode agrees", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async () => response(200, {
    status: "OK",
    results: [
      ...(googleExact("Dubbelpostvägen 7, 444 94 Ucklum", 58.07, 11.94,
        "Dubbelpostvägen", "7", "44494", "Ucklum", true) as { results: unknown[] }).results,
      ...(googleExact("Dubbelpostvägen 7, 411 35 Ucklum", 58.08, 11.95,
        "Dubbelpostvägen", "7", "41135", "Ucklum") as { results: unknown[] }).results,
    ],
  });

  const result = await geocodeDetailed({
    address: "Dubbelpostvägen 7", postalCode: "41135", city: "Ucklum",
  });
  assert.equal(result.status, "candidates");
  assert.equal(result.result, null);
  assert.equal(result.candidates.length, 2);
});

test("does not tolerate a postcode conflict without an explicitly requested locality", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async () => response(200, googleExact(
    "Utanortsvägen 8, 444 94 Ucklum", 58.07, 11.94,
    "Utanortsvägen", "8", "44494", "Ucklum",
  ));

  const result = await geocodeDetailed({ address: "Utanortsvägen 8", postalCode: "41136" });
  assert.equal(result.status, "candidates");
  assert.equal(result.result, null);
});

test("does not tolerate missing provider postcode evidence", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async () => response(200, googleExact(
    "Saknadpostvägen 9, Ucklum", 58.07, 11.94,
    "Saknadpostvägen", "9", undefined, "Ucklum",
  ));

  const result = await geocodeDetailed({
    address: "Saknadpostvägen 9", postalCode: "41137", city: "Ucklum",
  });
  assert.equal(result.status, "candidates");
  assert.equal(result.result, null);
});

test("does not tolerate a postcode conflict when the house or locality also differs", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const query = new URL(String(url)).searchParams.get("address") ?? "";
    return response(200, query.startsWith("Felhuspostvägen")
      ? googleExact("Felhuspostvägen 99, 444 94 Ucklum", 58.07, 11.94,
        "Felhuspostvägen", "99", "44494", "Ucklum", true)
      : googleExact("Felortpostvägen 10, 444 94 Kode", 58.0, 11.85,
        "Felortpostvägen", "10", "44494", "Kode", true));
  };

  for (const address of ["Felhuspostvägen 10", "Felortpostvägen 10"]) {
    const result = await geocodeDetailed({ address, postalCode: "41138", city: "Ucklum" });
    assert.equal(result.status, "candidates");
    assert.equal(result.result, null);
    assert.equal(result.candidates[0]?.partial, true);
  }
  assert.equal(calls, 2, "a double conflict must not invoke locality-alias proofs");
});

test("uses explicit postcode and locality to choose Stockholm over Kiruna", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async () => response(200, {
    status: "OK",
    results: [
      (googleExact(
        "Bastugatan 48, 118 25 Stockholm, Sweden",
        59.318,
        18.057,
        "Bastugatan",
        "48",
        "118 25",
        "Stockholm",
        true,
      ) as { results: unknown[] }).results[0],
      (googleExact(
        "Bastugatan 48, 981 31 Kiruna, Sweden",
        67.855,
        20.225,
        "Bastugatan",
        "48",
        "981 31",
        "Kiruna",
        true,
      ) as { results: unknown[] }).results[0],
    ],
  });

  const result = await geocodeDetailed({
    address: "Bastugatan 48",
    postalCode: "11825",
    city: "Stockholm",
  });

  assert.equal(result.status, "matched");
  assert.equal(result.result?.displayName, "Bastugatan 48, 118 25 Stockholm, Sweden");
  assert.equal(result.result?.latitude, 59.318);
});

test("keeps equally valid address-level candidates for dispatcher choice", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async () => response(200, {
    status: "OK",
    results: [
      (googleExact("Bastugatan 48, 118 26 Stockholm, Sweden", 59.3180, 18.0570, "Bastugatan", "48", "118 26", "Stockholm") as { results: unknown[] }).results[0],
      (googleExact("Bastugatan 48, 118 26 Stockholm, Sweden", 59.3181, 18.0571, "Bastugatan", "48", "118 26", "Stockholm") as { results: unknown[] }).results[0],
    ],
  });

  const result = await geocodeDetailed({
    address: "Stockholm 11826 Bastugatan 48",
    postalCode: "11826",
    city: "Stockholm",
  });

  assert.equal(result.status, "candidates");
  assert.equal(result.result, null);
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every((candidate) => candidate.partial === false));
});

test("does not auto-accept a wrong house or a result without address-level proof", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async (url) => {
    const query = new URL(String(url)).searchParams.get("address") ?? "";
    if (query.startsWith("Bastugatan")) {
      return response(200, googleExact(
        "Bastugatan 49, 118 27 Stockholm, Sweden",
        59.318,
        18.057,
        "Bastugatan",
        "49",
        "118 27",
        "Stockholm",
      ));
    }
    return response(200, {
      status: "OK",
      results: [{
        place_id: "stockholm-centroid",
        formatted_address: "Stockholm, Sweden",
        types: ["locality"],
        address_components: [{ long_name: "Stockholm", types: ["locality"] }],
        geometry: { location: { lat: 59.3293, lng: 18.0686 } },
      }],
    });
  };

  const wrongHouse = await geocodeDetailed({
    address: "Bastugatan 48",
    postalCode: "11827",
    city: "Stockholm",
  });
  assert.equal(wrongHouse.status, "candidates");
  assert.equal(wrongHouse.result, null);
  assert.equal(wrongHouse.candidates[0]?.partial, true);

  const missingProof = await geocodeDetailed("Stockholm 11825 Centrumpunkten 48");
  assert.equal(missingProof.status, "candidates");
  assert.equal(missingProof.result, null);
  assert.equal(missingProof.candidates[0]?.partial, true);
});

test("uses Google as the primary provider for an exact match", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async (url) => {
    assert.match(String(url), /maps\.googleapis\.com/);
    return response(200, googleExact("Storgatan 1, Stockholm", 59.3, 18.0, "Storgatan", "1"));
  };
  const result = await geocodeDetailed("Storgatan 1, Stockholm");
  assert.equal(result.status, "matched");
  assert.equal(result.result?.provider, "google");
});

test("deduplicates simultaneous geocoding requests for the same normalized address", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  let requestCount = 0;
  let releaseRequest: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => { releaseRequest = resolve; });
  globalThis.fetch = async () => {
    requestCount++;
    await requestStarted;
    return response(200, googleExact("Samlingsgatan 12, Stockholm", 59.31, 18.04, "Samlingsgatan", "12"));
  };

  const first = geocodeDetailed({ address: "Samlingsgatan 12", city: "Stockholm" });
  const second = geocodeDetailed("Samlingsgatan 12, Stockholm");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestCount, 1, "the duplicate request should join the provider request already in flight");
  releaseRequest!();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, "matched");
  assert.equal(secondResult.status, "matched");
  assert.equal(requestCount, 1);
});

test("falls back to Nominatim when Google has no result", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return String(url).includes("googleapis")
      ? response(200, { status: "ZERO_RESULTS", results: [] })
      : response(200, nominatimExact("Fallbackgatan 2, Stockholm", "59.31", "18.01", "Fallbackgatan", "2"));
  };
  const result = await geocodeDetailed("Fallbackgatan 2, Stockholm");
  assert.equal(result.status, "matched");
  assert.equal(result.result?.provider, "nominatim");
  const firstNominatim = calls.findIndex((url) => url.includes("nominatim"));
  assert.ok(firstNominatim > 0);
  assert.ok(calls.slice(0, firstNominatim).every((url) => url.includes("googleapis")));
});

test("keeps the street in broad queries and returns broad results as candidates", async () => {
  delete process.env.GOOGLE_MAPS_API_KEY;
  const queries: string[] = [];
  globalThis.fetch = async (url) => {
    const query = new URL(String(url)).searchParams.get("q") ?? "";
    queries.push(query);
    return query === "Unfindable street, Stockholm"
      ? response(200, [{
          place_id: 456,
          lat: "59.33",
          lon: "18.06",
          display_name: "Unfindable street, Stockholm",
          addresstype: "road",
        }])
      : response(200, []);
  };
  const result = await geocodeDetailed({ address: "Unfindable street 99", city: "Stockholm" });
  assert.equal(result.status, "candidates");
  assert.equal(result.candidates[0]?.partial, true);
  assert.ok(queries.every((query) => query.includes("Unfindable street")));
});

test("falls back after Google rate limiting and server failures", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async (url) => String(url).includes("googleapis")
    ? response(429, { status: "OVER_QUERY_LIMIT" })
    : response(200, nominatimExact("Kvotgatan 4, Stockholm", "59.4", "18.1", "Kvotgatan", "4"));
  const rateLimited = await geocodeDetailed("Kvotgatan 4, Stockholm");
  assert.equal(rateLimited.result?.provider, "nominatim");

  globalThis.fetch = async (url) => String(url).includes("googleapis")
    ? response(503, { status: "UNKNOWN_ERROR" })
    : response(200, nominatimExact("Servergatan 5, Stockholm", "59.41", "18.11", "Servergatan", "5"));
  const unavailable = await geocodeDetailed("Servergatan 5, Stockholm");
  assert.equal(unavailable.result?.provider, "nominatim");
});

test("does not auto-accept a broad Google result without partial_match", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async (url) => String(url).includes("googleapis")
    ? response(200, {
        status: "OK",
        results: [{
          place_id: "route-only",
          formatted_address: "Bredgatan, Stockholm",
          types: ["route"],
          geometry: { location: { lat: 59.32, lng: 18.07 } },
        }],
      })
    : response(503, {});
  const result = await geocodeDetailed("Bredgatan 7, Stockholm");
  assert.equal(result.status, "candidates");
  assert.equal(result.result, null);
  assert.equal(result.candidates[0]?.partial, true);
});

test("does not call Nominatim when Google already has a selectable candidate", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  let googleCalls = 0;
  let nominatimCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("googleapis")) {
      googleCalls++;
      return response(200, {
        status: "OK",
        results: [{
          place_id: "candidate-only",
          formatted_address: "Valbar väg, Stockholm",
          types: ["route"],
          geometry: { location: { lat: 59.32, lng: 18.07 } },
        }],
      });
    }
    nominatimCalls++;
    throw new Error("Nominatim should not be queried after a Google candidate");
  };

  const result = await geocodeDetailed("Valbar väg 7, Stockholm");
  assert.equal(result.status, "candidates");
  assert.equal(result.result, null);
  assert.equal(result.candidates[0]?.partial, true);
  assert.equal(googleCalls, 1);
  assert.equal(nominatimCalls, 0);
});

test("handles provider fetch timeouts as unavailable", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  process.env.GEOCODING_FETCH_TIMEOUT_MS = "5";
  let abortedCalls = 0;
  globalThis.fetch = async (_url, init) => {
    await new Promise<never>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("provider request must have an abort signal"));
        return;
      }
      const abort = () => {
        abortedCalls++;
        reject(new Error("provider request timed out"));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    throw new Error("unreachable");
  };

  const result = await geocodeDetailed("Timeoutsgatan 3, Stockholm");
  assert.equal(result.status, "provider_unavailable");
  assert.equal(result.result, null);
  assert.ok(abortedCalls >= 2, "both providers should be bounded by an abort timeout");
});

test("keeps an alias candidate when the bounded area proof times out", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  const originalTimeout = process.env.GEOCODING_FETCH_TIMEOUT_MS;
  process.env.GEOCODING_FETCH_TIMEOUT_MS = "5";
  let addressCalls = 0;
  let areaCalls = 0;
  try {
    globalThis.fetch = async (url, init) => {
      const parsed = new URL(String(url));
      const query = parsed.searchParams.get("address") ?? "";
      if (query.toLocaleLowerCase("sv-SE") === "timeoutarea") {
        areaCalls++;
        await new Promise<never>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("area request must have an abort signal"));
            return;
          }
          const abort = () => reject(new Error("area request timed out"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
        throw new Error("unreachable");
      }
      addressCalls++;
      return response(200, googleExact(
        "Timeoutgatan 4, 145 73 Norsborg, Sweden",
        59.245,
        17.832,
        "Timeoutgatan",
        "4",
        "145 73",
        "Norsborg",
      ));
    };

    const result = await geocodeDetailed({
      address: "Timeoutgatan 4",
      city: "Timeoutarea",
      postalCode: "14573",
    });

    assert.equal(result.status, "candidates");
    assert.equal(result.result, null);
    assert.equal(result.candidates[0]?.partial, true);
    assert.equal(addressCalls, 1);
    assert.equal(areaCalls, 1);
  } finally {
    if (originalTimeout === undefined) delete process.env.GEOCODING_FETCH_TIMEOUT_MS;
    else process.env.GEOCODING_FETCH_TIMEOUT_MS = originalTimeout;
  }
});

test("does not auto-accept a different street that merely contains the requested name", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async (url) => String(url).includes("googleapis")
    ? response(200, googleExact("Lilla Kyrkogatan 1, Stockholm", 59.35, 18.09, "Lilla Kyrkogatan", "1"))
    : response(503, {});
  const result = await geocodeDetailed("Kyrkogatan 1, Stockholm");
  assert.equal(result.status, "candidates");
  assert.equal(result.result, null);
  assert.equal(result.candidates[0]?.displayName, "Lilla Kyrkogatan 1, Stockholm");
});

test("does not auto-accept the same street and house number in a different locality", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async (url) => {
    if (!String(url).includes("googleapis")) return response(503, {});
    const query = new URL(String(url)).searchParams.get("address") ?? "";
    if (query.startsWith("Kommunvägen")) {
      return response(200, googleExact(
        "Kommunvägen 6, Göteborg",
        57.7,
        11.97,
        "Kommunvägen",
        "6",
        undefined,
        "Göteborg",
      ));
    }
    return response(200, googleExact(
      "Stationsgatan 9, 123 45 Göteborg",
      57.71,
      11.98,
      "Stationsgatan",
      "9",
      "123 45",
      "Göteborg",
    ));
  };

  const withoutPostcode = await geocodeDetailed("Kommunvägen 6, Stockholm");
  assert.equal(withoutPostcode.status, "candidates");
  assert.equal(withoutPostcode.result, null);

  const withPostcode = await geocodeDetailed("Stationsgatan 9, 123 45 Stockholm");
  assert.equal(withPostcode.status, "candidates");
  assert.equal(withPostcode.result, null);
});

test("extracts locality after a compact postcode and rejects the wrong locality", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async (url) => {
    if (!String(url).includes("googleapis")) return response(503, {});
    const query = new URL(String(url)).searchParams.get("address") ?? "";
    if (query.startsWith("Rättgatan")) {
      return response(200, googleExact(
        "Rättgatan 11, 234 56 Stockholm",
        59.38,
        18.12,
        "Rättgatan",
        "11",
        "234 56",
        "Stockholm",
      ));
    }
    return response(200, googleExact(
      "Kompaktgatan 10, 123 45 Göteborg",
      57.72,
      11.99,
      "Kompaktgatan",
      "10",
      "123 45",
      "Göteborg",
    ));
  };

  const correct = await geocodeDetailed("Rättgatan 11 234 56 Stockholm");
  assert.equal(correct.status, "matched");
  assert.equal(correct.result?.provider, "google");

  const wrong = await geocodeDetailed("Kompaktgatan 10 123 45 Stockholm");
  assert.equal(wrong.status, "candidates");
  assert.equal(wrong.result, null);
});

test("accepts a nearby Google locality alias only after an area proof", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  let addressCalls = 0;
  let areaCalls = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const query = parsed.searchParams.get("address") ?? "";
    if (query.toLocaleLowerCase("sv-SE") === "hallunda") {
      areaCalls++;
      const hallunda = (googleArea(
        "Hällunda",
        57.866,
        13.521,
        undefined,
        "523 75",
        ["locality", "political"],
      ) as { results: unknown[] }).results[0];
      const norsborg = (googleArea(
        "Norsborg",
        59.24607,
        17.82312,
        undefined,
        "145 69",
      ) as { results: unknown[] }).results[0];
      return response(200, { status: "OK", results: [hallunda, norsborg] });
    }
    addressCalls++;
    return response(200, googleExact(
      "Kryddgårdsvägen 4, 145 73 Norsborg, Sweden",
      59.251285,
      17.836275,
      "Kryddgårdsvägen",
      "4",
      "145 73",
      "Norsborg",
      false,
      "Slagsta",
    ));
  };

  const result = await geocodeDetailed({
    address: "KRYDDGÅRDSVÄGEN4",
    city: "HALLUNDA",
    postalCode: "14573",
  });

  assert.equal(result.status, "matched");
  assert.equal(result.result?.latitude, 59.251285);
  assert.equal(addressCalls, 1);
  assert.equal(areaCalls, 1);
});

test("does not fuzzy-normalize a misspelled street into an area alias", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  let areaCalls = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const query = parsed.searchParams.get("address") ?? "";
    if (query.toLocaleLowerCase("sv-SE") === "hallunda") {
      areaCalls++;
      return response(200, googleArea("Norsborg", 59.24607, 17.82312));
    }
    if (query.toLocaleLowerCase("sv-SE").startsWith("giffel")) {
      return response(200, googleExact(
        "Giffelvägen 13, 145 73 Norsborg, Sweden",
        59.251,
        17.836,
        "Giffelvägen",
        "13",
        "145 73",
        "Norsborg",
      ));
    }
    return response(200, googleExact(
      "Kryddgårdsvägen 4, 145 73 Norsborg, Sweden",
      59.251285,
      17.836275,
      "Kryddgårdsvägen",
      "4",
      "145 73",
      "Norsborg",
    ));
  };

  const result = await geocodeDetailed({
    address: "KRYDDÅRDSVÄGEN4",
    city: "HALLUNDA",
    postalCode: "14573",
  });

  assert.equal(result.status, "candidates");
  assert.equal(result.result, null);
  assert.equal(result.candidates[0]?.partial, true);
  assert.equal(areaCalls, 0);

  const compactTypo = await geocodeDetailed({
    address: "GIFFELVÄGEN13145",
    city: "HALLUNDA",
    postalCode: "14573",
  });
  assert.equal(compactTypo.status, "candidates");
  assert.equal(compactTypo.result, null);
  assert.equal(areaCalls, 0);
});

test("rejects a locality alias whose address candidate is far from the area", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  let areaCalls = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const query = parsed.searchParams.get("address") ?? "";
    if (query.toLocaleLowerCase("sv-SE") === "fararea") {
      areaCalls++;
      return response(200, googleArea("Fararea", 59.244, 17.831, {
        northeast: { lat: 59.28, lng: 17.90 },
        southwest: { lat: 59.21, lng: 17.77 },
      }));
    }
    return response(200, googleExact(
      "Farvägen 4, 145 73 Göteborg, Sweden",
      57.70,
      11.97,
      "Farvägen",
      "4",
      "145 73",
      "Göteborg",
    ));
  };

  const result = await geocodeDetailed({
    address: "Farvägen 4",
    city: "Fararea",
    postalCode: "14573",
  });

  assert.equal(result.status, "candidates");
  assert.equal(result.result, null);
  assert.equal(result.candidates[0]?.partial, true);
  assert.equal(areaCalls, 1);
});

test("does not request an area proof when street, house, or postcode evidence mismatches", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  let areaCalls = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const query = parsed.searchParams.get("address") ?? "";
    if (query.toLocaleLowerCase("sv-SE") === "proofarea") {
      areaCalls++;
      return response(200, googleArea("Proofarea", 59.244, 17.831));
    }
    return response(200, googleExact(
      "Proofgatan 9, 145 74 Norsborg, Sweden",
      59.245,
      17.832,
      "Proofgatan",
      "9",
      "145 74",
      "Norsborg",
    ));
  };

  const result = await geocodeDetailed({
    address: "Proofgatan 8",
    city: "Proofarea",
    postalCode: "14573",
  });

  assert.equal(result.status, "candidates");
  assert.equal(result.result, null);
  assert.equal(areaCalls, 0);
});

test("rejects an ambiguous set of locality-alias address candidates", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  let areaCalls = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const query = parsed.searchParams.get("address") ?? "";
    if (query.toLocaleLowerCase("sv-SE") === "ambiguousarea") {
      areaCalls++;
      return response(200, googleArea("Ambiguousarea", 59.244, 17.831));
    }
    const first = (googleExact(
      "Ambigatan 4, 145 73 Norsborg, Sweden",
      59.245,
      17.832,
      "Ambigatan",
      "4",
      "145 73",
      "Norsborg",
    ) as { results: unknown[] }).results[0];
    const second = (googleExact(
      "Ambigatan 4, 145 73 Norsborg, Sweden",
      59.246,
      17.833,
      "Ambigatan",
      "4",
      "145 73",
      "Norsborg",
    ) as { results: unknown[] }).results[0];
    return response(200, { status: "OK", results: [first, second] });
  };

  const result = await geocodeDetailed({
    address: "Ambigatan 4",
    city: "Ambiguousarea",
    postalCode: "14573",
  });

  assert.equal(result.status, "candidates");
  assert.equal(result.result, null);
  assert.equal(result.candidates.length, 2);
  assert.equal(areaCalls, 0);
});

test("reuses a bounded locality area proof for repeated aliases", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  let areaCalls = 0;
  let addressCalls = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const query = parsed.searchParams.get("address") ?? "";
    if (query.toLocaleLowerCase("sv-SE") === "reusearea") {
      areaCalls++;
      return response(200, googleArea("Reusearea", 59.244, 17.831, {
        northeast: { lat: 59.28, lng: 17.90 },
        southwest: { lat: 59.21, lng: 17.77 },
      }));
    }
    addressCalls++;
    const houseNumber = query.match(/Reusegatan\s+(\d+)/iu)?.[1] ?? "1";
    return response(200, googleExact(
      `Reusegatan ${houseNumber}, 145 73 Norsborg, Sweden`,
      59.245 + Number(houseNumber) / 1000,
      17.832,
      "Reusegatan",
      houseNumber,
      "145 73",
      "Norsborg",
    ));
  };

  const first = await geocodeDetailed({
    address: "Reusegatan 1",
    city: "Reusearea",
    postalCode: "14573",
  });
  const second = await geocodeDetailed({
    address: "Reusegatan 2",
    city: "Reusearea",
    postalCode: "14573",
  });

  assert.equal(first.status, "matched");
  assert.equal(second.status, "matched");
  assert.equal(addressCalls, 2);
  assert.equal(areaCalls, 1);
});

test("does not auto-accept a provider house when the request has no house number", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async (url) => String(url).includes("googleapis")
    ? response(200, googleExact(
        "Nummerlösagatan 1, Stockholm",
        59.36,
        18.1,
        "Nummerlösagatan",
        "1",
      ))
    : response(503, {});
  const googleResult = await geocodeDetailed("Nummerlösagatan, Stockholm");
  assert.equal(googleResult.status, "candidates");
  assert.equal(googleResult.result, null);

  delete process.env.GOOGLE_MAPS_API_KEY;
  globalThis.fetch = async () => response(200, nominatimExact(
    "Reservgatan 2, Stockholm",
    "59.37",
    "18.11",
    "Reservgatan",
    "2",
  ));
  const nominatimResult = await geocodeDetailed("Reservgatan, Stockholm");
  assert.equal(nominatimResult.status, "candidates");
  assert.equal(nominatimResult.result, null);
});

test("caches only verified exact matches and preserves their provider", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response(200, googleExact("Cachegatan 8, 111 22 Stockholm", 59.34, 18.08, "Cachegatan", "8", "111 22"));
  };
  const first = await geocodeDetailed("Cachegatan 8, 111 22 Stockholm");
  const second = await geocodeDetailed("Cachegatan 8, 111 22 Stockholm");
  assert.equal(first.status, "matched");
  assert.equal(second.result?.source, "cache");
  assert.equal(second.result?.provider, "google");
  assert.equal(calls, 1);
});

test("returns invalid_input for malformed runtime input instead of throwing", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response(500, {});
  };
  const result = await geocodeDetailed({ address: 123 } as unknown as { address: string });
  assert.equal(result.status, "invalid_input");
  assert.equal(calls, 0);
});

test("reports unavailable when both providers are unavailable", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  globalThis.fetch = async () => response(503, { status: "UNKNOWN_ERROR" });
  const result = await geocodeDetailed("All providers unavailable");
  assert.equal(result.status, "provider_unavailable");
});