import type { RequestHandler } from "express";
import { assertOrganizationDistrictAllowed } from "../services/organization-service-policy";
import { handleError } from "../lib/errors";

/** Every district operation uses the authenticated tenant, including platform users. */
export const requireDistrictEntitlement: RequestHandler = async (req, res, next) => {
  if (!req.user) {
    res.status(401).json({ error: "Inloggning krävs." });
    return;
  }
  try {
    await assertOrganizationDistrictAllowed(req.user.organizationId);
    next();
  } catch (error) { handleError(res, error); }
};
