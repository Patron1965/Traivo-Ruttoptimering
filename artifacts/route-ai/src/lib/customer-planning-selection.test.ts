import assert from "node:assert/strict";
import { test } from "node:test";
import {
  customerSelectionReadiness,
  reconcileCustomerSelection,
  toggleCustomerSelection,
  toggleCustomerSiteSelection,
  type CustomerSelectionCustomer,
} from "./customer-planning";

const customers: CustomerSelectionCustomer[] = [
  {
    id: "without-sites",
    sites: [],
  },
  {
    id: "with-sites",
    sites: [
      { id: "active-site", customerId: "with-sites" },
      { id: "archived-site", customerId: "with-sites", archivedAt: "2026-01-01" },
    ],
  },
  {
    id: "archived-customer",
    archivedAt: "2026-01-01",
    sites: [{ id: "archived-customer-site", customerId: "archived-customer" }],
  },
];

test("selecting a customer without sites remains explicit and not ready", () => {
  const selection = toggleCustomerSelection(
    customers,
    { customerIds: new Set(), siteIds: new Set() },
    "without-sites",
    true,
  );

  assert.deepEqual([...selection.customerIds], ["without-sites"]);
  assert.deepEqual([...selection.siteIds], []);
  assert.deepEqual(
    customerSelectionReadiness(customers, selection).customersMissingSites,
    ["without-sites"],
  );
  assert.equal(customerSelectionReadiness(customers, selection).isReady, false);
});

test("customer selection includes only active sites", () => {
  const selection = toggleCustomerSelection(
    customers,
    { customerIds: new Set(), siteIds: new Set() },
    "with-sites",
    true,
  );

  assert.deepEqual([...selection.customerIds], ["with-sites"]);
  assert.deepEqual([...selection.siteIds], ["active-site"]);
});

test("site selection keeps its customer selected while allowing an empty site set", () => {
  const selected = toggleCustomerSiteSelection(
    customers,
    { customerIds: new Set(), siteIds: new Set() },
    "active-site",
    true,
  );
  const cleared = toggleCustomerSiteSelection(customers, selected, "active-site", false);

  assert.deepEqual([...cleared.customerIds], ["with-sites"]);
  assert.deepEqual([...cleared.siteIds], []);
  assert.deepEqual(
    customerSelectionReadiness(customers, cleared).customersMissingSites,
    ["with-sites"],
  );
});

test("reconciliation removes archived and stale ids", () => {
  const selection = reconcileCustomerSelection(customers, {
    customerIds: new Set(["with-sites", "archived-customer", "missing-customer"]),
    siteIds: new Set(["active-site", "archived-site", "missing-site"]),
  });

  assert.deepEqual([...selection.customerIds], ["with-sites"]);
  assert.deepEqual([...selection.siteIds], ["active-site"]);
});