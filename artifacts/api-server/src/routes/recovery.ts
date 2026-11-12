import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { handleError } from "../lib/errors";
import {
  issuePasswordReset,
  isPasswordRecoveryConfigured,
  normalizeRecoveryEmail,
  PASSWORD_RESET_ACCEPTED_MESSAGE,
  PASSWORD_RESET_COMPLETE_MESSAGE,
  PASSWORD_RESET_INVALID_MESSAGE,
  PASSWORD_RESET_UNAVAILABLE_MESSAGE,
  resetPassword,
} from "../lib/password-recovery";

const router: IRouter = Router();

const forgotPasswordSchema = z.object({ email: z.string().email() });
const resetPasswordSchema = z.object({
  token: z.string().min(1),
  // This is the existing account password floor. Passwords are never logged.
  password: z.string().min(8),
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: false,
  validate: false,
  keyGenerator: (req) => req.ip ?? "unknown",
  handler: (_req, res) => {
    res.status(429).json({ message: PASSWORD_RESET_ACCEPTED_MESSAGE });
  },
});

router.post("/auth/forgot-password", forgotPasswordLimiter, async (req, res) => {
  try {
    // Check global delivery configuration before looking up the address. This
    // keeps the explicit operational 503 identical for known and unknown
    // addresses and avoids account enumeration during an outage.
    if (!isPasswordRecoveryConfigured()) {
      res.status(503).json({ message: PASSWORD_RESET_UNAVAILABLE_MESSAGE });
      return;
    }

    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(202).json({ message: PASSWORD_RESET_ACCEPTED_MESSAGE });
      return;
    }

    // Delivery failures are logged operationally by the recovery service but
    // deliberately do not change this response: known and unknown addresses
    // must have identical observable account-enumeration behavior.
    await issuePasswordReset(normalizeRecoveryEmail(parsed.data.email));

    res.status(202).json({ message: PASSWORD_RESET_ACCEPTED_MESSAGE });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/auth/reset-password", async (req, res) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: PASSWORD_RESET_INVALID_MESSAGE });
      return;
    }

    const ok = await resetPassword(parsed.data.token, parsed.data.password);
    if (!ok) {
      res.status(400).json({ message: PASSWORD_RESET_INVALID_MESSAGE });
      return;
    }

    res.json({ message: PASSWORD_RESET_COMPLETE_MESSAGE });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;