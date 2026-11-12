import assert from "node:assert/strict";
import test from "node:test";
import {
  composeDeliveryAddress,
  deliveryAddressPreview,
  getDeliveryAddressMapping,
  resolveDeliveryAddressValues,
} from "./delivery-address.ts";

const headers = ["Gata", "Postkod", "Postort", "Komplett adress"];

test("composes ordered street, postcode and city columns into one preview", () => {
  const mapping = {
    address: [
      { component: "address" as const, column: "Gata" },
      { component: "postalCode" as const, column: "Postkod" },
      { component: "city" as const, column: "Postort" },
    ],
  };

  assert.deepEqual(
    resolveDeliveryAddressValues(mapping, headers, ["AKTERGATAN 12 LGH 1002", "12066", "STOCKHOLM", ""]),
    {
      address: "AKTERGATAN 12 LGH 1002",
      postalCode: "12066",
      city: "STOCKHOLM",
      composed: true,
    },
  );
  assert.equal(
    deliveryAddressPreview(mapping, headers, ["AKTERGATAN 12 LGH 1002", "12066", "STOCKHOLM", ""]),
    "AKTERGATAN 12 LGH 1002 12066 STOCKHOLM",
  );
  assert.equal(
    deliveryAddressPreview(
      JSON.parse(JSON.stringify(mapping)) as typeof mapping,
      headers,
      ["AKTERGATAN 12 LGH 1002", "12066", "STOCKHOLM", ""],
    ),
    "AKTERGATAN 12 LGH 1002 12066 STOCKHOLM",
  );
});

test("preserves a legacy complete-address column and does not duplicate structured fields", () => {
  const mapping = { address: "Komplett adress", postalCode: "Postkod", city: "Postort" };
  assert.deepEqual(getDeliveryAddressMapping(mapping), [
    { component: "address", column: "Komplett adress" },
    { component: "postalCode", column: "Postkod" },
    { component: "city", column: "Postort" },
  ]);
  assert.equal(
    composeDeliveryAddress("AKTERGATAN 12 LGH 1002 12066 STOCKHOLM", "12066", "STOCKHOLM"),
    "AKTERGATAN 12 LGH 1002 12066 STOCKHOLM",
  );
});

test("omits blank components and keeps leading zeroes in postcodes", () => {
  const mapping = {
    address: [
      { component: "address" as const, column: "Gata" },
      { component: "postalCode" as const, column: "Postkod" },
      { component: "city" as const, column: "Postort" },
    ],
  };
  assert.equal(
    deliveryAddressPreview(mapping, headers, ["Gata 4 LGH 1002", "01234", "", ""]),
    "Gata 4 LGH 1002 01234",
  );
  assert.equal(
    composeDeliveryAddress("Gata 4", "01234", undefined, { composed: true }),
    "Gata 4 01234",
  );
});

test("an explicit composed mapping is authoritative over old dedicated mappings", () => {
  const mapping = {
    address: [
      { component: "address" as const, column: "Gata" },
      { component: "postalCode" as const, column: "Postkod" },
    ],
    // Old drafts can retain these fields after the address target is composed.
    postalCode: "Postkod",
    city: "Postort",
  };
  assert.deepEqual(
    resolveDeliveryAddressValues(mapping, headers, ["Gata 4", "01234", "STOCKHOLM", ""]),
    {
      address: "Gata 4",
      postalCode: "01234",
      city: undefined,
      composed: true,
    },
  );
});