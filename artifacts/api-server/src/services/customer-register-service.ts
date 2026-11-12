import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  db,
  customersTable,
  customerSitesTable,
  customerVisitIdempotencyTable,
  planningDraftsTable,
  routesTable,
  stopsTable,
  type Customer,
  type CustomerUnavailablePeriod,
  type CustomerSite,
  type CustomerSiteVerificationMetadata,
  type StopUnavailablePeriod,
} from "@workspace/db";
import { geocodeDetailed, type GeocodeCandidate, type GeocodeResult } from "./geocoding";
import { stockholmClock } from "./route-workday";
import { payloadIdentityHash } from "./planning-draft-service";
import { lockPlanStopTarget, registerPlanStopMembership, PlanStopConflictError } from "./plan-stop-membership";
import { broadcastDataChange } from "./realtime";

export type CustomerSiteInput = {
  name: string;
  address: string;
  verificationCandidateId?: string;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  serviceDurationMin?: number;
  isPrioritized?: boolean;
  instructions?: string | null;
};
export type UpdateCustomerSiteInput = CustomerSiteInput & {
  expectedRevision: number;
};

export type CustomerWithSites = Customer & { sites: CustomerSite[] };

export class CustomerRegisterError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 422 | 503 = 400,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CustomerRegisterError";
  }
}

const MAX_UNAVAILABLE_PERIODS = 100;
const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function normalizeUnavailablePeriods(
  value: CustomerUnavailablePeriod[] | null | undefined,
): CustomerUnavailablePeriod[] {
  const periods = value ?? [];
  if (!Array.isArray(periods) || periods.length > MAX_UNAVAILABLE_PERIODS) {
    throw new CustomerRegisterError(
      `unavailablePeriods must contain at most ${MAX_UNAVAILABLE_PERIODS} periods.`,
      422,
      "INVALID_UNAVAILABLE_PERIOD",
    );
  }
  const normalized = periods.map((period, index) => {
    if (
      !period
      || !Number.isInteger(period.weekday)
      || period.weekday < 1
      || period.weekday > 7
      || typeof period.start !== "string"
      || typeof period.end !== "string"
      || !CLOCK_PATTERN.test(period.start)
      || !CLOCK_PATTERN.test(period.end)
    ) {
      throw new CustomerRegisterError(
        `unavailablePeriods[${index}] must use an ISO weekday (1-7) and HH:mm times.`,
        422,
        "INVALID_UNAVAILABLE_PERIOD",
      );
    }
    if (period.start >= period.end) {
      throw new CustomerRegisterError(
        `unavailablePeriods[${index}] must end after it starts. Overnight periods are not supported; split them across two weekday entries.`,
        422,
        "INVALID_UNAVAILABLE_PERIOD",
      );
    }
    return {
      weekday: period.weekday,
      start: period.start,
      end: period.end,
    };
  });
  return normalized.sort((left, right) =>
    left.weekday - right.weekday
    || left.start.localeCompare(right.start)
    || left.end.localeCompare(right.end));
}

/**
 * Materialize a customer's recurring weekday closures for one planning date.
 * This is shared by every customer-linked stop creation path; recurring
 * customer data must never be copied into a stop as if it were already UTC.
 */
export function materializeCustomerUnavailablePeriods(
  date: Date,
  periods: CustomerUnavailablePeriod[],
): StopUnavailablePeriod[] {
  const isoWeekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  return periods
    .filter((period) => period.weekday === isoWeekday)
    .map((period) => {
      const start = stockholmClock(date, period.start);
      const end = stockholmClock(date, period.end);
      if (end.getTime() <= start.getTime()) {
        throw new CustomerRegisterError(
          "The unavailable period cannot be represented on this daylight-saving transition date.",
          422,
          "INVALID_UNAVAILABLE_PERIOD",
        );
      }
      return { start: start.toISOString(), end: end.toISOString() };
    });
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

const customerFieldMaxLengths = {
  name: 200,
  email: 320,
  phone: 100,
  address: 500,
  customerNumber: 100,
  organizationNumber: 100,
  contactName: 200,
  postalCode: 30,
  city: 100,
  country: 100,
  billingEmail: 320,
  billingAddress: 500,
  notes: 2000,
} as const;

function normalizeCustomerField(
  value: string | null | undefined,
  field: keyof typeof customerFieldMaxLengths,
): string | null {
  const normalized = normalizeOptional(value);
  if (normalized != null && normalized.length > customerFieldMaxLengths[field]) {
    throw new CustomerRegisterError(
      `${field} must be at most ${customerFieldMaxLengths[field]} characters.`,
      422,
      "INVALID_CUSTOMER",
    );
  }
  return normalized;
}

type CustomerMetadataInput = {
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  customerNumber?: string | null;
  organizationNumber?: string | null;
  contactName?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  billingEmail?: string | null;
  billingAddress?: string | null;
  notes?: string | null;
  unavailablePeriods?: CustomerUnavailablePeriod[];
};

function normalizeCustomerFields(input: CustomerMetadataInput) {
  return {
    ...(input.email === undefined ? {} : { email: normalizeCustomerField(input.email, "email") }),
    ...(input.phone === undefined ? {} : { phone: normalizeCustomerField(input.phone, "phone") }),
    ...(input.address === undefined ? {} : { address: normalizeCustomerField(input.address, "address") }),
    ...(input.customerNumber === undefined ? {} : { customerNumber: normalizeCustomerField(input.customerNumber, "customerNumber") }),
    ...(input.organizationNumber === undefined ? {} : { organizationNumber: normalizeCustomerField(input.organizationNumber, "organizationNumber") }),
    ...(input.contactName === undefined ? {} : { contactName: normalizeCustomerField(input.contactName, "contactName") }),
    ...(input.postalCode === undefined ? {} : { postalCode: normalizeCustomerField(input.postalCode, "postalCode") }),
    ...(input.city === undefined ? {} : { city: normalizeCustomerField(input.city, "city") }),
    ...(input.country === undefined ? {} : { country: normalizeCustomerField(input.country, "country") }),
    ...(input.billingEmail === undefined ? {} : { billingEmail: normalizeCustomerField(input.billingEmail, "billingEmail") }),
    ...(input.billingAddress === undefined ? {} : { billingAddress: normalizeCustomerField(input.billingAddress, "billingAddress") }),
    ...(input.notes === undefined ? {} : { notes: normalizeCustomerField(input.notes, "notes") }),
    ...(input.unavailablePeriods === undefined ? {} : {
      unavailablePeriods: normalizeUnavailablePeriods(input.unavailablePeriods),
    }),
  };
}

function validateClock(value: string | null | undefined, field: string): string | null {
  if (value == null || value === "") return null;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new CustomerRegisterError(
      `${field} must be an HH:mm local time in Europe/Stockholm.`,
      422,
      "INVALID_SITE_WINDOW",
    );
  }
  return value;
}

function validateSiteInput(input: CustomerSiteInput): CustomerSiteInput {
  if (input.isPrioritized !== undefined && typeof input.isPrioritized !== "boolean") {
    throw new CustomerRegisterError("isPrioritized must be a boolean.", 422, "INVALID_SITE");
  }
  const name = input.name.trim();
  const address = input.address.trim();
  if (!name) {
    throw new CustomerRegisterError("Site name must not be blank.", 422, "INVALID_SITE");
  }
  if (!address) {
    throw new CustomerRegisterError("Site address must not be blank.", 422, "INVALID_SITE");
  }
  const windowStart = validateClock(input.windowStart, "windowStart");
  const windowEnd = validateClock(input.windowEnd, "windowEnd");
  if ((windowStart == null) !== (windowEnd == null)) {
    throw new CustomerRegisterError(
      "windowStart and windowEnd must be supplied together.",
      422,
      "INVALID_SITE_WINDOW",
    );
  }
  if (windowStart != null && windowEnd != null && windowStart >= windowEnd) {
    throw new CustomerRegisterError(
      "windowEnd must be later than windowStart.",
      422,
      "INVALID_SITE_WINDOW",
    );
  }
  const serviceDurationMin = input.serviceDurationMin ?? 5;
  if (!Number.isInteger(serviceDurationMin) || serviceDurationMin < 0 || serviceDurationMin > 1440) {
    throw new CustomerRegisterError(
      "serviceDurationMin must be an integer between 0 and 1440.",
      422,
      "INVALID_SITE_DURATION",
    );
  }
  return {
    ...input,
    name,
    address,
    verificationCandidateId: normalizeOptional(input.verificationCandidateId) ?? undefined,
    contactName: normalizeOptional(input.contactName),
    contactPhone: normalizeOptional(input.contactPhone),
    contactEmail: normalizeOptional(input.contactEmail),
    windowStart,
    windowEnd,
    serviceDurationMin,
    instructions: normalizeOptional(input.instructions),
  };
}

function verificationFromResult(
  input: CustomerSiteInput,
  detailed: Awaited<ReturnType<typeof geocodeDetailed>>,
): {
  address: string;
  latitude: number;
  longitude: number;
  verificationStatus: "exact" | "candidate";
  verificationMetadata: CustomerSiteVerificationMetadata;
} {
  const exact = detailed.result;
  if (detailed.status === "matched" && exact) {
    return {
      address: exact.displayName,
      latitude: exact.latitude,
      longitude: exact.longitude,
      verificationStatus: "exact",
      verificationMetadata: {
        provider: exact.provider,
        source: exact.source,
        displayName: exact.displayName,
        query: detailed.query,
      },
    };
  }

  const candidate = input.verificationCandidateId
    ? detailed.candidates.find((item) => item.id === input.verificationCandidateId)
    : undefined;
  if (candidate) {
    return {
      address: candidate.displayName,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      verificationStatus: "candidate",
      verificationMetadata: {
        provider: candidate.source,
        source: candidate.source,
        displayName: candidate.displayName,
        query: detailed.query,
        candidateId: candidate.id,
      },
    };
  }

  throw new CustomerRegisterError(
    detailed.status === "provider_unavailable"
      ? "Address verification provider is unavailable. No site was saved."
      : "Choose an address candidate returned by the verification provider before saving this site.",
    detailed.status === "provider_unavailable" ? 503 : 422,
    detailed.status === "provider_unavailable"
      ? "ADDRESS_VERIFICATION_PROVIDER_UNAVAILABLE"
      : "ADDRESS_VERIFICATION_REQUIRED",
    {
      query: detailed.query,
      candidates: detailed.candidates,
    },
  );
}

async function prepareSite(input: CustomerSiteInput) {
  const normalized = validateSiteInput(input);
  const detailed = await geocodeDetailed(normalized.address);
  const verified = verificationFromResult(normalized, detailed);
  return {
    ...normalized,
    ...verified,
    addressInput: normalized.address,
  };
}

async function sitesForCustomers(
  organizationId: string,
  customerIds: string[],
  includeArchived: boolean,
): Promise<Map<string, CustomerSite[]>> {
  if (customerIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(customerSitesTable)
    .where(and(
      eq(customerSitesTable.organizationId, organizationId),
      inArray(customerSitesTable.customerId, customerIds),
      ...(includeArchived ? [] : [isNull(customerSitesTable.archivedAt)]),
    ));
  const byCustomer = new Map<string, CustomerSite[]>();
  for (const row of rows) {
    const current = byCustomer.get(row.customerId) ?? [];
    current.push(row);
    byCustomer.set(row.customerId, current);
  }
  return byCustomer;
}

function withSites(customer: Customer, byCustomer: Map<string, CustomerSite[]>): CustomerWithSites {
  return { ...customer, sites: byCustomer.get(customer.id) ?? [] };
}

export async function listCustomers(
  organizationId: string,
  includeArchived = false,
): Promise<CustomerWithSites[]> {
  const customers = await db
    .select()
    .from(customersTable)
    .where(and(
      eq(customersTable.organizationId, organizationId),
      ...(includeArchived ? [] : [isNull(customersTable.archivedAt)]),
    ));
  const byCustomer = await sitesForCustomers(
    organizationId,
    customers.map((customer) => customer.id),
    includeArchived,
  );
  return customers.map((customer) => withSites(customer, byCustomer));
}

export async function createCustomer(input: {
  organizationId: string;
  name: string;
} & CustomerMetadataInput & {
  sites?: CustomerSiteInput[];
  skipExisting?: boolean;
}): Promise<CustomerWithSites> {
  const name = input.name.trim();
  if (!name) throw new CustomerRegisterError("Customer name must not be blank.", 422, "INVALID_CUSTOMER");
  if (name.length > customerFieldMaxLengths.name) {
    throw new CustomerRegisterError(
      `name must be at most ${customerFieldMaxLengths.name} characters.`,
      422,
      "INVALID_CUSTOMER",
    );
  }
  const customerFields = normalizeCustomerFields(input);
  const duplicateCondition = and(
    eq(customersTable.organizationId, input.organizationId),
    customerFields.customerNumber
      ? sql`lower(trim(${customersTable.customerNumber})) = lower(trim(${customerFields.customerNumber}))`
      : and(
        sql`lower(trim(${customersTable.name})) = lower(trim(${name}))`,
        sql`lower(trim(coalesce(${customersTable.address}, ''))) = lower(trim(${customerFields.address ?? ""}))`,
      ),
  );
  if (input.skipExisting) {
    const [existing] = await db.select({ id: customersTable.id }).from(customersTable).where(duplicateCondition).limit(1);
    if (existing) throw new CustomerRegisterError("Kunden finns redan och har hoppats över.", 409, "CUSTOMER_IMPORT_EXISTS");
  }
  const preparedSites = await Promise.all((input.sites ?? []).map(prepareSite));
  return db.transaction(async (tx) => {
    // Serialize imports with ordinary customer creation; archived customers also count.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-create:${input.organizationId}`}, 0))`);
    if (input.skipExisting) {
      const [existing] = await tx.select({ id: customersTable.id }).from(customersTable).where(duplicateCondition).limit(1);
      if (existing) throw new CustomerRegisterError("Kunden finns redan och har hoppats över.", 409, "CUSTOMER_IMPORT_EXISTS");
    }
    const [customer] = await tx.insert(customersTable).values({
      organizationId: input.organizationId,
      name,
      ...customerFields,
    }).returning();
    if (preparedSites.length > 0) {
      await tx.insert(customerSitesTable).values(preparedSites.map((site) => ({
        organizationId: input.organizationId,
        customerId: customer.id,
        name: site.name,
        addressInput: site.addressInput,
        address: site.address,
        latitude: site.latitude,
        longitude: site.longitude,
        verificationStatus: site.verificationStatus,
        verificationMetadata: site.verificationMetadata,
        contactName: site.contactName,
        contactPhone: site.contactPhone,
        contactEmail: site.contactEmail,
        windowStart: site.windowStart,
        windowEnd: site.windowEnd,
        serviceDurationMin: site.serviceDurationMin,
        isPrioritized: site.isPrioritized ?? false,
        instructions: site.instructions,
      })));
    }
    const sites = await tx.select().from(customerSitesTable).where(eq(customerSitesTable.customerId, customer.id));
    return { ...customer, sites };
  });
}

export async function updateCustomer(
  organizationId: string,
  id: string,
  input: { name?: string } & CustomerMetadataInput,
): Promise<CustomerWithSites | null> {
  const values = {
    ...(input.name === undefined ? {} : { name: input.name.trim() }),
    ...normalizeCustomerFields(input),
  };
  if (values.name !== undefined && !values.name) {
    throw new CustomerRegisterError("Customer name must not be blank.", 422, "INVALID_CUSTOMER");
  }
  if (values.name !== undefined && values.name.length > customerFieldMaxLengths.name) {
    throw new CustomerRegisterError(
      `name must be at most ${customerFieldMaxLengths.name} characters.`,
      422,
      "INVALID_CUSTOMER",
    );
  }
  const customer = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(customersTable).where(and(
      eq(customersTable.id, id),
      eq(customersTable.organizationId, organizationId),
      isNull(customersTable.archivedAt),
    )).limit(1).for("update");
    if (!existing) return null;

    const nextUnavailablePeriods = values.unavailablePeriods as CustomerUnavailablePeriod[] | undefined;
    const constraintsChanged = nextUnavailablePeriods !== undefined
      && JSON.stringify(existing.unavailablePeriods) !== JSON.stringify(nextUnavailablePeriods);
    if (constraintsChanged) {
      const [activeRoute] = await tx
        .select({ id: routesTable.id })
        .from(stopsTable)
        .innerJoin(routesTable, eq(routesTable.id, stopsTable.routeId))
        .where(and(
          eq(stopsTable.organizationId, organizationId),
          eq(stopsTable.customerId, id),
          or(
            eq(routesTable.status, "in_progress"),
            ne(routesTable.handoffStatus, "pending"),
          ),
        ))
        .limit(1);
      if (activeRoute) {
        throw new CustomerRegisterError(
          "Unavailable periods cannot be changed while this customer has an active route.",
          409,
          "CUSTOMER_UNAVAILABLE_PERIODS_ACTIVE_ROUTE",
        );
      }
    }

    const [updated] = await tx.update(customersTable).set(values).where(and(
      eq(customersTable.id, id),
      eq(customersTable.organizationId, organizationId),
      isNull(customersTable.archivedAt),
    )).returning();
    return updated ?? null;
  });
  if (!customer) return null;
  const byCustomer = await sitesForCustomers(organizationId, [id], false);
  return withSites(customer, byCustomer);
}

export async function createSite(
  organizationId: string,
  customerId: string,
  input: CustomerSiteInput,
): Promise<CustomerWithSites | null> {
  const prepared = await prepareSite(input);
  const result = await db.transaction(async (tx) => {
    const [customer] = await tx.select().from(customersTable).where(and(
      eq(customersTable.id, customerId),
      eq(customersTable.organizationId, organizationId),
      isNull(customersTable.archivedAt),
    )).limit(1).for("update");
    if (!customer) return null;
    await tx.insert(customerSitesTable).values({
      organizationId,
      customerId,
      name: prepared.name,
      addressInput: prepared.addressInput,
      address: prepared.address,
      latitude: prepared.latitude,
      longitude: prepared.longitude,
      verificationStatus: prepared.verificationStatus,
      verificationMetadata: prepared.verificationMetadata,
      contactName: prepared.contactName,
      contactPhone: prepared.contactPhone,
      contactEmail: prepared.contactEmail,
      windowStart: prepared.windowStart,
      windowEnd: prepared.windowEnd,
      serviceDurationMin: prepared.serviceDurationMin,
      isPrioritized: prepared.isPrioritized ?? false,
      instructions: prepared.instructions,
    });
    const sites = await tx.select().from(customerSitesTable).where(and(
      eq(customerSitesTable.customerId, customerId),
      isNull(customerSitesTable.archivedAt),
    ));
    return { ...customer, sites };
  });
  return result;
}

export async function updateSite(
  organizationId: string,
  customerId: string,
  siteId: string,
  input: UpdateCustomerSiteInput,
): Promise<CustomerWithSites | null> {
  const normalized = validateSiteInput(input);
  const [existingSite] = await db.select().from(customerSitesTable).where(and(
    eq(customerSitesTable.id, siteId),
    eq(customerSitesTable.customerId, customerId),
    eq(customerSitesTable.organizationId, organizationId),
    isNull(customerSitesTable.archivedAt),
  )).limit(1);
  if (!existingSite) return null;
  // Contact/window edits do not invalidate an address verification. A new
  // provider result is required only when the address itself changes.
  const prepared = normalized.address === existingSite.addressInput
    ? {
      ...normalized,
      addressInput: existingSite.addressInput,
      address: existingSite.address,
      latitude: existingSite.latitude,
      longitude: existingSite.longitude,
      verificationStatus: existingSite.verificationStatus,
      verificationMetadata: existingSite.verificationMetadata,
    }
    : await prepareSite(normalized);
  const result = await db.transaction(async (tx) => {
    const [customer] = await tx.select().from(customersTable).where(and(
      eq(customersTable.id, customerId),
      eq(customersTable.organizationId, organizationId),
      isNull(customersTable.archivedAt),
    )).limit(1).for("update");
    if (!customer) return null;
    const [lockedSite] = await tx.select().from(customerSitesTable).where(and(
      eq(customerSitesTable.id, siteId),
      eq(customerSitesTable.customerId, customerId),
      eq(customerSitesTable.organizationId, organizationId),
      isNull(customerSitesTable.archivedAt),
    )).limit(1).for("update");
    if (!lockedSite) return null;
    if (lockedSite.revision !== input.expectedRevision) {
      throw new CustomerRegisterError(
        "The customer site changed. Reload it before saving.",
        409,
        "CUSTOMER_SITE_REVISION_CONFLICT",
        { revision: lockedSite.revision },
      );
    }
    const [site] = await tx.update(customerSitesTable).set({
      name: prepared.name,
      addressInput: prepared.addressInput,
      address: prepared.address,
      latitude: prepared.latitude,
      longitude: prepared.longitude,
      verificationStatus: prepared.verificationStatus,
      verificationMetadata: prepared.verificationMetadata,
      contactName: prepared.contactName,
      contactPhone: prepared.contactPhone,
      contactEmail: prepared.contactEmail,
      windowStart: prepared.windowStart,
      windowEnd: prepared.windowEnd,
      serviceDurationMin: prepared.serviceDurationMin,
      ...(input.isPrioritized === undefined ? {} : { isPrioritized: prepared.isPrioritized }),
      instructions: prepared.instructions,
      revision: sql`${customerSitesTable.revision} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(customerSitesTable.id, siteId),
      eq(customerSitesTable.customerId, customerId),
      eq(customerSitesTable.organizationId, organizationId),
      isNull(customerSitesTable.archivedAt),
      eq(customerSitesTable.revision, input.expectedRevision),
    )).returning();
    if (!site) return null;
    const sites = await tx.select().from(customerSitesTable).where(and(
      eq(customerSitesTable.customerId, customerId),
      isNull(customerSitesTable.archivedAt),
    ));
    return { ...customer, sites };
  });
  return result;
}

export async function archiveCustomer(organizationId: string, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [customer] = await tx.update(customersTable).set({ archivedAt: now }).where(and(
      eq(customersTable.id, id),
      eq(customersTable.organizationId, organizationId),
      isNull(customersTable.archivedAt),
    )).returning({ id: customersTable.id });
    if (!customer) return false;
    await tx.update(customerSitesTable).set({ archivedAt: now, updatedAt: now }).where(and(
      eq(customerSitesTable.organizationId, organizationId),
      eq(customerSitesTable.customerId, id),
      isNull(customerSitesTable.archivedAt),
    ));
    return true;
  });
}

export async function archiveSite(
  organizationId: string,
  customerId: string,
  siteId: string,
  expectedRevision: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [lockedSite] = await tx.select().from(customerSitesTable).where(and(
      eq(customerSitesTable.id, siteId),
      eq(customerSitesTable.customerId, customerId),
      eq(customerSitesTable.organizationId, organizationId),
      isNull(customerSitesTable.archivedAt),
    )).limit(1).for("update");
    if (!lockedSite) return false;
    if (lockedSite.revision !== expectedRevision) {
      throw new CustomerRegisterError(
        "The customer site changed. Reload it before archiving.",
        409,
        "CUSTOMER_SITE_REVISION_CONFLICT",
        { revision: lockedSite.revision },
      );
    }
    const [site] = await tx.update(customerSitesTable).set({
      archivedAt: new Date(),
      updatedAt: new Date(),
      revision: sql`${customerSitesTable.revision} + 1`,
    }).where(and(
      eq(customerSitesTable.id, siteId),
      eq(customerSitesTable.customerId, customerId),
      eq(customerSitesTable.organizationId, organizationId),
      isNull(customerSitesTable.archivedAt),
      eq(customerSitesTable.revision, expectedRevision),
    )).returning({ id: customerSitesTable.id });
    return Boolean(site);
  });
}

function dateOnlyToDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CustomerRegisterError("date must use YYYY-MM-DD.", 422, "INVALID_VISIT_DATE");
  }
  const [year, month, day] = value.split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (
    utcDate.getUTCFullYear() !== year
    || utcDate.getUTCMonth() !== month - 1
    || utcDate.getUTCDate() !== day
  ) {
    throw new CustomerRegisterError("date is not a valid calendar date.", 422, "INVALID_VISIT_DATE");
  }
  return utcDate;
}

function stopWindow(
  date: Date,
  value: string | null,
): Date | null {
  return value == null ? null : stockholmClock(date, value);
}

function activeStateSelectedStopIds(state: unknown): string[] {
  if (!state || typeof state !== "object" || Array.isArray(state)) return [];
  const selected = (state as Record<string, unknown>).selectedStopIds;
  return Array.isArray(selected)
    ? selected.filter((item): item is string => typeof item === "string")
    : [];
}

function stateStringArray(state: unknown, key: string): string[] {
  if (!state || typeof state !== "object" || Array.isArray(state)) return [];
  const value = (state as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function importedResultStopIds(result: unknown): string[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const record = result as Record<string, unknown>;
  const ids = Array.isArray(record.stopIds)
    ? record.stopIds.filter((item): item is string => typeof item === "string")
    : [];
  const stops = Array.isArray(record.stops) ? record.stops : [];
  for (const stop of stops) {
    if (!stop || typeof stop !== "object" || Array.isArray(stop)) continue;
    const id = (stop as Record<string, unknown>).id ?? (stop as Record<string, unknown>).stopId;
    if (typeof id === "string") ids.push(id);
  }
  const rowResults = Array.isArray(record.rowResults) ? record.rowResults : [];
  for (const row of rowResults) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const id = (row as Record<string, unknown>).stopId;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

export type CustomerVisitPlanRequest = {
  organizationId: string;
  siteIds: string[];
  date: string;
  planName?: string;
  draftId?: string;
  draftRevision?: number;
  planId?: string;
  routes?: Array<{ routeId: string; planRevision: number }>;
  allowDuplicateVisits?: boolean;
  idempotencyKey: string;
};

export type CustomerVisitPlanResult = {
  draftId?: string;
  planId?: string;
  stopIds: string[];
  count: number;
};

export async function planCustomerVisits(
  input: CustomerVisitPlanRequest,
): Promise<CustomerVisitPlanResult> {
  const { result } = await planCustomerVisitsWithMeta(input);
  return result;
}

export async function planCustomerVisitsWithMeta(
  input: CustomerVisitPlanRequest,
): Promise<{ result: CustomerVisitPlanResult; replayed: boolean }> {
  const date = dateOnlyToDate(input.date);
  if ((input.planId && (input.draftId || input.draftRevision != null)) ||
      (input.planId && !input.routes?.length) || (!input.planId && input.routes !== undefined)) {
    throw new CustomerRegisterError(
      "Use either planId with routes revision snapshot, or draftId with draftRevision.",
      422, "INVALID_VISIT_TARGET",
    );
  }
  if (input.allowDuplicateVisits !== undefined && typeof input.allowDuplicateVisits !== "boolean") {
    throw new CustomerRegisterError("allowDuplicateVisits must be a boolean.", 422, "INVALID_VISIT_TARGET");
  }
  const siteIds = [...new Set(input.siteIds)].sort();
  if (siteIds.length === 0 || siteIds.length !== input.siteIds.length) {
    throw new CustomerRegisterError(
      "siteIds must contain one or more unique site ids.",
      422,
      "INVALID_SITE_IDS",
    );
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new CustomerRegisterError(
      "idempotencyKey must be between 1 and 200 characters.",
      422,
      "INVALID_IDEMPOTENCY_KEY",
    );
  }
  const payloadHash = payloadIdentityHash({
    siteIds,
    date: input.date,
    planName: input.planName?.trim() || null,
    draftId: input.draftId ?? null,
    draftRevision: input.draftRevision ?? null,
    planId: input.planId ?? null,
    routes: input.routes ? [...input.routes].sort((a, b) => a.routeId.localeCompare(b.routeId)) : null,
    allowDuplicateVisits: input.allowDuplicateVisits ?? false,
  });

  let updatedRouteIds: string[] = [];
  const outcome = await db.transaction(async (tx) => {
    // Serialize same-key retries before checking or inserting the durable
    // idempotency record. The lock is transaction-scoped and tenant-scoped.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"customer-visits:" + input.organizationId + ":" + idempotencyKey}))`);
    const [existingRequest] = await tx.select().from(customerVisitIdempotencyTable).where(and(
      eq(customerVisitIdempotencyTable.organizationId, input.organizationId),
      eq(customerVisitIdempotencyTable.idempotencyKey, idempotencyKey),
    )).limit(1).for("update");
    if (existingRequest) {
      if (existingRequest.payloadHash !== payloadHash) {
        throw new CustomerRegisterError(
          "This idempotency key was already used for a different request.",
          409,
          "IDEMPOTENCY_KEY_REUSED",
        );
      }
      return { result: existingRequest.result, replayed: true };
    }

    let draftId = input.draftId;
    let draft = null as typeof planningDraftsTable.$inferSelect | null;
    let planRoutes: Array<typeof routesTable.$inferSelect> = [];
    if (input.planId) {
      try {
        planRoutes = await lockPlanStopTarget(tx, input.organizationId, {
          planId: input.planId, routes: input.routes!,
        });
      } catch (error) {
        if (!(error instanceof PlanStopConflictError)) throw error;
        throw new CustomerRegisterError(error.message, 409, "PLAN_REVISION_CONFLICT");
      }
      if (planRoutes[0].date.toISOString().slice(0, 10) !== input.date) {
        throw new CustomerRegisterError(
          "The visit date must match the operational plan date.", 409, "PLAN_DATE_CONFLICT",
        );
      }
    } else if (draftId) {
      const [lockedDraft] = await tx.select().from(planningDraftsTable).where(and(
        eq(planningDraftsTable.id, draftId),
        eq(planningDraftsTable.organizationId, input.organizationId),
      )).limit(1).for("update");
      if (!lockedDraft) {
        throw new CustomerRegisterError("Planning draft not found.", 404, "DRAFT_NOT_FOUND");
      }
      if (input.draftRevision == null || input.draftRevision !== lockedDraft.revision) {
        throw new CustomerRegisterError(
          "The planning draft changed. Reload it before adding visits.",
          409,
          "DRAFT_REVISION_CONFLICT",
          { draftRevision: lockedDraft.revision },
        );
      }
      if (lockedDraft.startAt.getTime() !== date.getTime()) {
        throw new CustomerRegisterError(
          "The visit date must match the planning draft date.",
          409,
          "DRAFT_DATE_CONFLICT",
        );
      }
      if (lockedDraft.planId) {
        throw new CustomerRegisterError(
          "This draft already has an active route plan. Create a new draft or use protected replanning.",
          409,
          "DRAFT_ACTIVE_REQUIRES_REPLAN",
        );
      }
      const linkedRoutes = await tx.select({ status: routesTable.status, handoffStatus: routesTable.handoffStatus })
        .from(routesTable)
        .where(and(
          eq(routesTable.organizationId, input.organizationId),
          eq(routesTable.draftId, lockedDraft.id),
        ));
      if (linkedRoutes.some((route) =>
        route.status !== "draft" || route.handoffStatus !== "pending"
      )) {
        throw new CustomerRegisterError(
          "This draft is already active or sent and cannot be changed silently.",
          409,
          "DRAFT_ACTIVE_REQUIRES_REPLAN",
        );
      }
      draft = lockedDraft;
    } else {
      const [createdDraft] = await tx.insert(planningDraftsTable).values({
        organizationId: input.organizationId,
        name: input.planName?.trim() || `Kundbesök ${input.date}`,
        // Draft dates are date-only UTC anchors. Stockholm conversion is
        // intentionally reserved for stop service-window instants.
        startAt: date,
        state: {
          source: "manual",
          step: 5,
          selectedStopIds: [],
          planningDate: input.date,
        },
      }).returning();
      draft = createdDraft;
      draftId = createdDraft.id;
    }

    // Lock customers before their sites (same order as site editing and manual
    // plan-stop creation), then validate all data before inserting a visit.
    const selectedSites = await tx.select().from(customerSitesTable).where(and(
      eq(customerSitesTable.organizationId, input.organizationId),
      inArray(customerSitesTable.id, siteIds),
      isNull(customerSitesTable.archivedAt),
    ));
    if (selectedSites.length !== siteIds.length) {
      throw new CustomerRegisterError(
        "One or more selected sites are missing, archived, or belong to another organization.",
        422, "INVALID_SITE_SELECTION",
      );
    }
    const customers = await tx.select().from(customersTable).where(and(
      eq(customersTable.organizationId, input.organizationId),
      inArray(customersTable.id, selectedSites.map((site) => site.customerId)),
      isNull(customersTable.archivedAt),
    )).orderBy(customersTable.id).for("update");
    const customerById = new Map(customers.map((customer) => [customer.id, customer]));
    const sites = await tx.select().from(customerSitesTable).where(and(
      eq(customerSitesTable.organizationId, input.organizationId),
      inArray(customerSitesTable.id, siteIds),
      isNull(customerSitesTable.archivedAt),
    )).orderBy(customerSitesTable.id).for("update");
    if (sites.length !== siteIds.length || sites.some((site) => !customerById.has(site.customerId))) {
      throw new CustomerRegisterError(
        "One or more selected sites belong to an archived or missing customer.",
        422, "INVALID_SITE_SELECTION",
      );
    }

    // Target locks above serialize concurrent additions, including different
    // idempotency keys. Inspect persisted membership, not the caller's selection.
    // Legacy draft state can also contain temporary UI selection keys. Preserve
    // those in state, but only persisted UUIDs can identify database stops.
    const draftStopIds = draft ? [...new Set([
      ...importedResultStopIds(draft.importedResult),
      ...activeStateSelectedStopIds(draft.state),
      ...stateStringArray(draft.state, "importedStopIds"),
      ...stateStringArray(draft.state, "customerVisitStopIds"),
      ...stateStringArray(draft.state, "appendedStopIds"),
    ])].filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) : [];
    if (!input.allowDuplicateVisits && (input.planId || draftStopIds.length)) {
      const duplicates = await tx.select({ siteId: stopsTable.customerSiteId }).from(stopsTable).where(and(
        eq(stopsTable.organizationId, input.organizationId),
        isNull(stopsTable.archivedAt),
        inArray(stopsTable.customerSiteId, siteIds),
        input.planId
          ? or(
            and(
              eq(stopsTable.planningPlanId, input.planId),
              eq(stopsTable.planningDate, planRoutes[0].date),
              isNull(stopsTable.routeId),
            ),
            inArray(stopsTable.routeId, planRoutes.map((route) => route.id)),
          )
          : inArray(stopsTable.id, draftStopIds),
      ));
      const duplicateSiteIds = [...new Set(duplicates.map((stop) => stop.siteId!))].sort();
      if (duplicateSiteIds.length) {
        throw new CustomerRegisterError(
          "Selected customer sites already have visits in this plan. Confirm repeat visits explicitly.",
          409, "DUPLICATE_CUSTOMER_VISITS", { siteIds: duplicateSiteIds },
        );
      }
    }

    const createdStops = await tx.insert(stopsTable).values(sites.map((site) => {
      const customer = customerById.get(site.customerId)!;
      return {
        organizationId: input.organizationId,
        customerId: customer.id,
        customerSiteId: site.id,
        customerName: customer.name,
        customerSiteName: site.name,
        address: site.address,
        latitude: site.latitude,
        longitude: site.longitude,
        timeWindowStart: stopWindow(date, site.windowStart),
        timeWindowEnd: stopWindow(date, site.windowEnd),
        unavailablePeriods: materializeCustomerUnavailablePeriods(
          date,
          customer.unavailablePeriods,
        ),
        serviceDurationMin: site.serviceDurationMin,
        priority: site.isPrioritized ? 1 : 0,
        notes: site.instructions,
        contactName: site.contactName,
        contactEmail: site.contactEmail,
        contactPhone: site.contactPhone,
        status: "pending" as const,
        planningDate: input.planId ? planRoutes[0].date : date,
        planningPlanId: input.planId ?? null,
        ...(input.planId ? { unplannedReason: "Nytt stopp väntar på manuell tilldelning." } : {}),
      };
    })).returning({ id: stopsTable.id, priority: stopsTable.priority });
    const stopIds = createdStops.map((stop) => stop.id);
    if (input.planId) {
      updatedRouteIds = await registerPlanStopMembership(tx, planRoutes, createdStops);
    }
    if (draft) {
      const previousSelected = activeStateSelectedStopIds(draft.state);
      const importedIds = [
        ...importedResultStopIds(draft.importedResult),
        ...stateStringArray(draft.state, "importedStopIds"),
        ...previousSelected,
      ];
      const nextState = {
        ...(draft.state ?? {}),
        ...(input.draftId ? {} : { source: "manual" }),
        planningDate: input.date,
        importedStopIds: [...new Set(importedIds)],
        selectedStopIds: [...new Set([...importedIds, ...stopIds])],
        customerVisitStopIds: [
          ...new Set([
            ...stateStringArray(draft.state, "customerVisitStopIds"),
            ...stopIds,
          ]),
        ],
      };
      if (input.draftId) {
        await tx.update(planningDraftsTable).set({
          state: nextState,
          revision: sql`${planningDraftsTable.revision} + 1`,
          updatedAt: new Date(),
        }).where(and(
          eq(planningDraftsTable.id, draft.id),
          eq(planningDraftsTable.organizationId, input.organizationId),
          eq(planningDraftsTable.revision, input.draftRevision!),
        ));
      } else {
        await tx.update(planningDraftsTable).set({
          state: nextState,
          updatedAt: new Date(),
        }).where(and(
          eq(planningDraftsTable.id, draft.id),
          eq(planningDraftsTable.organizationId, input.organizationId),
        ));
      }
    }
    const result: CustomerVisitPlanResult = {
      ...(input.planId ? { planId: input.planId } : { draftId: draftId! }),
      stopIds, count: stopIds.length,
    };
    await tx.insert(customerVisitIdempotencyTable).values({
      organizationId: input.organizationId,
      idempotencyKey,
      payloadHash,
      result,
    });
    return { result, replayed: false };
  });
  // Realtime refresh is emitted only once the transaction has committed. A
  // response-loss retry returns the exact durable result without re-emitting.
  if (!outcome.replayed) {
    broadcastDataChange(input.organizationId, "stop", "created", {
      stopIds: outcome.result.stopIds,
      ...(outcome.result.planId ? { planId: outcome.result.planId } : {}),
    });
    for (const id of updatedRouteIds) {
      broadcastDataChange(input.organizationId, "route", "updated", { id, planId: input.planId });
    }
  }
  return outcome;
}