import { Router } from "express";
import rateLimit from "express-rate-limit";
import { SendSmsBody } from "@workspace/api-zod";
import { isLinkSmsConfigured, isValidLinkSms, sendLinkSms } from "../services/link-sms";
import { currentOrganizationServicePolicy } from "../services/organization-service-policy";

const router = Router();
const smsLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user!.organizationId,
  message: { error: "För många SMS-försök. Vänta en minut." },
});

// Authentication and administrator-only authorization run in the parent router.
router.post("/send-sms", smsLimiter, async (req, res): Promise<void> => {
  const policy = currentOrganizationServicePolicy();
  if (policy.smsProvider !== "inherit" && policy.smsProvider !== "linkmobility") {
    res.status(403).json({ error: "LINK Mobility är inte tillåten för organisationen." });
    return;
  }
  const parsed = SendSmsBody.strict().safeParse(req.body);
  if (!parsed.success || !isValidLinkSms(parsed.data)) {
    res.status(400).json({ error: "Ange en alfanumerisk avsändare (1–11 tecken, minst en bokstav), ett svenskt mobilnummer (+467…) och 1–459 tecken meddelandetext." });
    return;
  }
  if (!isLinkSmsConfigured()) {
    res.status(503).json({ error: "LINK Mobilitys API-uppgifter saknas." });
    return;
  }
  if (!await sendLinkSms(parsed.data)) {
    res.status(502).json({ error: "SMS kunde inte bekräftas av LINK Mobility. Kontrollera leverantörens status innan du försöker igen." });
    return;
  }
  res.status(202).json({ status: "accepted" });
});

export default router;
