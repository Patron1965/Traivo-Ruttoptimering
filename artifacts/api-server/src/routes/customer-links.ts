import { Router, type IRouter } from "express";
import { z } from "zod";
import { CustomerLinkError, manageCustomerLink } from "../services/customer-links";
import { privateLinkHeaders } from "./public-tracking";
import { customerSmsPreview, sendCustomerLinkSms } from "../services/customer-link-sms";
import { GetCustomerSmsPreviewParams, GetCustomerSmsPreviewResponse, SendCustomerSmsBody } from "@workspace/api-zod";

const router: IRouter = Router();
const bodySchema = z.object({ action: z.enum(["create", "replace", "revoke"]) }).strict();
router.use("/stops/:id/customer-link", privateLinkHeaders, (req, res, next) => {
  if (!req.user) { res.status(401).json({ error: "Authentication required", code: "UNAUTHORIZED" }); return; }
  if (!["admin", "dispatcher"].includes(req.user.role)) {
    res.status(403).json({ error: "Insufficient role", code: "FORBIDDEN" }); return;
  }
  next();
});
router.route("/stops/:id/customer-link").get(async (req, res) => {
  try {
    if (!z.guid().safeParse(req.params.id).success) throw new CustomerLinkError("STOP_NOT_FOUND", 404, "Leveransen finns inte.");
    res.json(await manageCustomerLink(String(req.params.id), req.user!.organizationId));
  } catch (err) {
    res.status(err instanceof CustomerLinkError ? err.httpStatus : 500).json({
      error: err instanceof CustomerLinkError ? err.message : "Kundlänken kunde inte läsas.",
      code: err instanceof CustomerLinkError ? err.code : "CUSTOMER_LINK_ERROR",
    });
  }
}).post(async (req, res) => {
  const body = bodySchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Invalid action", code: "INVALID_ACTION" }); return; }
  try {
    if (!z.guid().safeParse(req.params.id).success) throw new CustomerLinkError("STOP_NOT_FOUND", 404, "Leveransen finns inte.");
    res.json(await manageCustomerLink(String(req.params.id), req.user!.organizationId, body.data.action));
  } catch (err) {
    res.status(err instanceof CustomerLinkError ? err.httpStatus : 500).json({
      error: err instanceof CustomerLinkError ? err.message : "Kundlänken kunde inte ändras.",
      code: err instanceof CustomerLinkError ? err.code : "CUSTOMER_LINK_ERROR",
    });
  }
});
router.route("/stops/:id/customer-link/sms").get(async (req, res) => {
  try {
    if (!GetCustomerSmsPreviewParams.safeParse(req.params).success) throw new CustomerLinkError("STOP_NOT_FOUND", 404, "Leveransen finns inte.");
    res.json(GetCustomerSmsPreviewResponse.parse(await customerSmsPreview(String(req.params.id), req.user!.organizationId)));
  } catch (err) {
    res.status(err instanceof CustomerLinkError ? err.httpStatus : 500).json({ error: err instanceof CustomerLinkError ? err.message : "SMS-status kunde inte hämtas." });
  }
}).post(async (req, res) => {
  const input = SendCustomerSmsBody.strict().safeParse(req.body);
  if (!input.success || !z.guid().safeParse(req.params.id).success) { res.status(400).json({ error: "Ogiltig SMS-bekräftelse." }); return; }
  try {
    res.json(await sendCustomerLinkSms(String(req.params.id), req.user!.organizationId, req.user!.id, input.data));
  } catch (err) {
    res.status(err instanceof CustomerLinkError ? err.httpStatus : 500).json({ error: err instanceof CustomerLinkError ? err.message : "Resultatet är okänt. Uppdatera status innan du gör något mer." });
  }
});
export default router;