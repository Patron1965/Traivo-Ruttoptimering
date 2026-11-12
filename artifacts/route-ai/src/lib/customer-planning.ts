import { getErrorStatus, hasErrorCode } from "./localize-error";

export type CustomerSelectionCustomer = {
  id: string;
  archivedAt?: unknown;
  sites?: CustomerSelectionSite[];
};

export type CustomerSelectionSite = {
  id: string;
  archivedAt?: unknown;
  customerId?: string;
};

export type CustomerSelectionState = {
  customerIds: Set<string>;
  siteIds: Set<string>;
};

function isActive(value: { archivedAt?: unknown }): boolean {
  return !value.archivedAt;
}

export function activeCustomerSites<T extends CustomerSelectionSite>(
  customer: { archivedAt?: unknown; sites?: T[] },
): T[] {
  if (!isActive(customer)) return [];
  return (customer.sites ?? []).filter(isActive);
}

/**
 * Remove selections which no longer represent writable, active register data.
 * Customer selections are deliberately retained when they have no sites: that
 * state is what lets the route preparation step ask for the first verified site.
 */
export function reconcileCustomerSelection(
  customers: CustomerSelectionCustomer[],
  selection: CustomerSelectionState,
): CustomerSelectionState {
  const activeCustomers = customers.filter(isActive);
  const validCustomerIds = new Set(activeCustomers.map((customer) => customer.id));
  const validSiteIds = new Set(
    activeCustomers.flatMap((customer) => activeCustomerSites(customer).map((site) => site.id)),
  );

  return {
    customerIds: new Set([...selection.customerIds].filter((id) => validCustomerIds.has(id))),
    siteIds: new Set([...selection.siteIds].filter((id) => validSiteIds.has(id))),
  };
}

export function toggleCustomerSelection(
  customers: CustomerSelectionCustomer[],
  selection: CustomerSelectionState,
  customerId: string,
  checked: boolean,
): CustomerSelectionState {
  const customer = customers.find((candidate) => candidate.id === customerId);
  const next = reconcileCustomerSelection(customers, selection);
  if (!customer || !isActive(customer)) return next;

  if (checked) {
    next.customerIds.add(customerId);
    activeCustomerSites(customer).forEach((site) => next.siteIds.add(site.id));
  } else {
    next.customerIds.delete(customerId);
    activeCustomerSites(customer).forEach((site) => next.siteIds.delete(site.id));
  }

  return next;
}

export function toggleCustomerSiteSelection(
  customers: CustomerSelectionCustomer[],
  selection: CustomerSelectionState,
  siteId: string,
  checked: boolean,
): CustomerSelectionState {
  const next = reconcileCustomerSelection(customers, selection);
  const owner = customers.find((customer) => activeCustomerSites(customer).some((site) => site.id === siteId));
  if (!owner) return next;

  next.customerIds.add(owner.id);
  if (checked) next.siteIds.add(siteId);
  else next.siteIds.delete(siteId);
  return next;
}

export function customerSelectionReadiness(
  customers: CustomerSelectionCustomer[],
  selection: CustomerSelectionState,
): {
  selectedCustomerIds: string[];
  selectedSiteIds: string[];
  customersMissingSites: string[];
  isReady: boolean;
} {
  const reconciled = reconcileCustomerSelection(customers, selection);
  const selectedCustomerIds = [...reconciled.customerIds];
  const selectedSiteIds = [...reconciled.siteIds];
  const customersMissingSites = selectedCustomerIds.filter((customerId) => {
    const customer = customers.find((candidate) => candidate.id === customerId);
    if (!customer) return true;
    const activeSiteIds = new Set(activeCustomerSites(customer).map((site) => site.id));
    return !selectedSiteIds.some((siteId) => activeSiteIds.has(siteId));
  });

  return {
    selectedCustomerIds,
    selectedSiteIds,
    customersMissingSites,
    isReady: selectedCustomerIds.length > 0
      && selectedSiteIds.length > 0
      && customersMissingSites.length === 0,
  };
}

export function customerAddressCandidates(error: unknown): unknown[] | null {
  if (getErrorStatus(error) !== 422 || !hasErrorCode(error, "ADDRESS_VERIFICATION_REQUIRED")) return null;
  const data = (error as { data?: { details?: { candidates?: unknown } } }).data;
  return Array.isArray(data?.details?.candidates) ? data.details.candidates : [];
}

export function isCustomerDraftEligible(
  draft: { startAt: string; planId?: string | null },
  date: string,
): boolean {
  return !draft.planId && draft.startAt.slice(0, 10) === date;
}