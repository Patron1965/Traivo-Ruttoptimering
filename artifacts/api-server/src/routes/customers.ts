import { Router, type IRouter, type Response } from "express";
import {
  ArchiveCustomerParams,
  ArchiveCustomerSiteParams,
  CreateCustomerBody,
  ImportCustomerRowBody,
  CreateCustomerResponse,
  CreateCustomerSiteBody,
  CreateCustomerSiteParams,
  CreateCustomerSiteResponse,
  ListCustomersQueryParams,
  ListCustomersResponse,
  PlanCustomerVisitsBody,
  PlanCustomerVisitsResponse,
  UpdateCustomerBody,
  UpdateCustomerParams,
  UpdateCustomerResponse,
  UpdateCustomerSiteBody,
  UpdateCustomerSiteParams,
  UpdateCustomerSiteResponse,
  ArchiveCustomerSiteQueryParams,
} from "@workspace/api-zod";
import { z } from "zod";
import { getOrgId, requireRole } from "../middleware/auth";
import {
  archiveCustomer,
  archiveSite,
  createCustomer,
  createSite,
  CustomerRegisterError,
  listCustomers,
  planCustomerVisitsWithMeta,
  updateCustomer,
  updateSite,
} from "../services/customer-register-service";

const router: IRouter = Router();
const customerRead = requireRole("admin", "dispatcher", "viewer");
const customerWrite = requireRole("admin", "dispatcher");

function sendCustomerError(res: Response, error: unknown): void {
  if (error instanceof CustomerRegisterError) {
    res.status(error.statusCode).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: "Invalid customer register request.",
      code: "INVALID_CUSTOMER_REQUEST",
      issues: error.issues,
    });
    return;
  }
  throw error;
}

router.get("/customers", customerRead, async (req, res): Promise<void> => {
  try {
    // Boolean("false") is true; query-string booleans require explicit parsing.
    const includeArchived = z.enum(["true", "false"]).optional().parse(req.query.includeArchived);
    const query = ListCustomersQueryParams.parse({ includeArchived: includeArchived === "true" });
    const customers = await listCustomers(getOrgId(req), query.includeArchived);
    res.json(ListCustomersResponse.parse(customers));
  } catch (error) {
    sendCustomerError(res, error);
  }
});

router.post("/customers", customerWrite, async (req, res): Promise<void> => {
  try {
    const body = CreateCustomerBody.parse(req.body);
    const customer = await createCustomer({
      organizationId: getOrgId(req),
      name: body.name,
      email: body.email,
      phone: body.phone,
        address: body.address,
        customerNumber: body.customerNumber,
        organizationNumber: body.organizationNumber,
        contactName: body.contactName,
        postalCode: body.postalCode,
        city: body.city,
        country: body.country,
        billingEmail: body.billingEmail,
        billingAddress: body.billingAddress,
        notes: body.notes,
        unavailablePeriods: body.unavailablePeriods,
      sites: body.sites,
    });
    res.status(201).json(CreateCustomerResponse.parse(customer));
  } catch (error) {
    sendCustomerError(res, error);
  }
});

router.post("/customers/import-row", customerWrite, async (req, res): Promise<void> => {
  try {
    const body = ImportCustomerRowBody.parse(req.body);
    await createCustomer({ ...body, organizationId: getOrgId(req), skipExisting: true });
    res.json({ outcome: "created" });
  } catch (error) {
    if (error instanceof CustomerRegisterError && error.code === "CUSTOMER_IMPORT_EXISTS") {
      res.json({ outcome: "skipped" });
      return;
    }
    sendCustomerError(res, error);
  }
});

router.put("/customers/:id", customerWrite, async (req, res): Promise<void> => {
  try {
    const params = UpdateCustomerParams.parse(req.params);
    const body = UpdateCustomerBody.parse(req.body);
    const customer = await updateCustomer(getOrgId(req), params.id, body);
    if (!customer) {
      res.status(404).json({ error: "Customer not found", code: "CUSTOMER_NOT_FOUND" });
      return;
    }
    res.json(UpdateCustomerResponse.parse(customer));
  } catch (error) {
    sendCustomerError(res, error);
  }
});

router.delete("/customers/:id", customerWrite, async (req, res): Promise<void> => {
  try {
    const params = ArchiveCustomerParams.parse(req.params);
    if (!await archiveCustomer(getOrgId(req), params.id)) {
      res.status(404).json({ error: "Customer not found", code: "CUSTOMER_NOT_FOUND" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    sendCustomerError(res, error);
  }
});

router.post("/customers/:id/sites", customerWrite, async (req, res): Promise<void> => {
  try {
    const params = CreateCustomerSiteParams.parse(req.params);
    const body = CreateCustomerSiteBody.parse(req.body);
    const customer = await createSite(getOrgId(req), params.id, body);
    if (!customer) {
      res.status(404).json({ error: "Customer not found", code: "CUSTOMER_NOT_FOUND" });
      return;
    }
    res.status(201).json(CreateCustomerSiteResponse.parse(customer));
  } catch (error) {
    sendCustomerError(res, error);
  }
});

router.put("/customers/:id/sites/:siteId", customerWrite, async (req, res): Promise<void> => {
  try {
    const params = UpdateCustomerSiteParams.parse(req.params);
    const body = UpdateCustomerSiteBody.parse(req.body);
    const customer = await updateSite(getOrgId(req), params.id, params.siteId, body);
    if (!customer) {
      res.status(404).json({ error: "Customer site not found", code: "CUSTOMER_SITE_NOT_FOUND" });
      return;
    }
    res.json(UpdateCustomerSiteResponse.parse(customer));
  } catch (error) {
    sendCustomerError(res, error);
  }
});

router.delete("/customers/:id/sites/:siteId", customerWrite, async (req, res): Promise<void> => {
  try {
    const params = ArchiveCustomerSiteParams.parse(req.params);
    const query = ArchiveCustomerSiteQueryParams.parse(req.query);
    if (!await archiveSite(getOrgId(req), params.id, params.siteId, query.expectedRevision)) {
      res.status(404).json({ error: "Customer site not found", code: "CUSTOMER_SITE_NOT_FOUND" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    sendCustomerError(res, error);
  }
});

router.post("/customers/plan-visits", customerWrite, async (req, res): Promise<void> => {
  try {
    // The generated parser intentionally coerces date inputs for compatibility
    // with other APIs. This endpoint is date-only by contract, so reject a
    // timestamp before coercion could move it across a Swedish calendar day.
    if (typeof req.body?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) {
      res.status(422).json({
        error: "date must use YYYY-MM-DD.",
        code: "INVALID_VISIT_DATE",
      });
      return;
    }
    const body = PlanCustomerVisitsBody.parse(req.body);
    const { result, replayed } = await planCustomerVisitsWithMeta({
      organizationId: getOrgId(req),
      siteIds: body.siteIds,
      date: req.body.date,
      planName: body.planName,
      draftId: body.draftId,
      draftRevision: body.draftRevision,
      planId: body.planId,
      routes: body.routes,
      allowDuplicateVisits: body.allowDuplicateVisits,
      idempotencyKey: body.idempotencyKey,
    });
    res.status(replayed ? 200 : 201).json(PlanCustomerVisitsResponse.parse(result));
  } catch (error) {
    sendCustomerError(res, error);
  }
});

export default router;