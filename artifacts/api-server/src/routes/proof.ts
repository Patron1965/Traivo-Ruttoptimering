import { Router, json, type IRouter, type Request, type Response, type NextFunction } from "express";
import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import multer from "multer";
import { db, stopsTable, deliveryProofsTable, routesTable, vehiclesTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";
import { ObjectStorageService } from "../lib/objectStorage";
import { ObjectAccessGroupType, ObjectPermission } from "../lib/objectAcl";
import { validateAndScanImage } from "../lib/file-scan";
import { logUploadRejected } from "../lib/security-log";
import { requireProofReadAccess } from "../middleware/field-service-read-access";
import { z } from "zod";
import {
  ExecutionEventError,
  recordProofExecutionEvent,
  validateExecutionEventContext,
} from "../services/execution-event-service";
import {
  DriverAssistanceError,
  executionActorForRequest,
  getDriverAssistanceContext,
} from "../lib/driver-assistance";

const router: IRouter = Router();


const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported image format"));
    }
  },
});

const jsonParser = json({ limit: "5mb" });
const ProofExecutionMetadata = z.object({
  clientEventId: z.string().min(1).max(200),
  planVersion: z.coerce.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
});

function flexibleParser(req: Request, res: Response, next: NextFunction) {
  const ct = req.headers["content-type"] || "";
  if (ct.includes("multipart/form-data")) {
    photoUpload.single("photo")(req, res, (err: unknown) => {
      if (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Invalid file upload" });
        return;
      }
      next();
    });
  } else {
    jsonParser(req, res, next);
  }
}

async function verifyStopAccess(stopId: string, organizationId: string) {
  const [stop] = await db
    .select()
    .from(stopsTable)
    .where(and(eq(stopsTable.id, stopId), eq(stopsTable.organizationId, organizationId)));
  return stop || null;
}

router.post("/stops/:id/proof", flexibleParser, async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const organizationId = req.user!.organizationId;
    const actor = executionActorForRequest(req, getDriverAssistanceContext(req));

    if (!organizationId) {
      res.status(400).json({ error: "organizationId query parameter is required" });
      return;
    }

    let stop = await verifyStopAccess(id, organizationId);
    if (!stop) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }
    const executionMetadata = ProofExecutionMetadata.parse(req.body);
    const clientEventId = executionMetadata.clientEventId;
    // Validate tenant, driver ownership and the accepted plan *before* image
    // scanning/upload. A stale/off-route driver must not create stored bytes.
    const outgoingContext = await validateExecutionEventContext({
      organizationId,
      driverProfileId: actor.driverProfileId,
      role: actor.role,
      stopId: id,
      planVersion: executionMetadata.planVersion,
      assistedRouteId: actor.assistedRouteId,
      assistedDriverId: actor.assistedDriverId,
    });
    if (actor.role === "driver") stop = outgoingContext.stop;

    const file = (req as Request & { file?: Express.Multer.File }).file;

    // proofStage distinguishes pickup evidence (PoP) from delivery evidence (PoD).
    // Defaults to "delivery" so existing clients remain unaffected.
    const rawStage = (file ? req.body?.proofStage : req.body?.proofStage) as unknown;
    const proofStage: "pickup" | "delivery" =
      rawStage === "pickup" ? "pickup" : "delivery";

    if (file) {
      const scan = validateAndScanImage({ buffer: file.buffer, declaredType: file.mimetype });
      if (!scan.ok) {
        logUploadRejected(req, scan.error, id).catch(() => {});
        res.status(scan.status).json({ error: scan.error });
        return;
      }

      const storageService = new ObjectStorageService();
      const uploadUrl = await storageService.getObjectEntityUploadURL();

      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": scan.contentType },
        body: file.buffer,
      });

      if (!uploadResponse.ok) {
        res.status(502).json({ error: "Failed to upload photo to storage" });
        return;
      }

      await storageService.trySetObjectEntityAclPolicy(uploadUrl, {
        owner: req.user!.id,
        visibility: "private",
        aclRules: [
          {
            group: { type: ObjectAccessGroupType.ORG_MEMBERS, id: organizationId },
            permission: ObjectPermission.READ,
          },
        ],
      });

      const fileUrl = storageService.normalizeObjectEntityPath(uploadUrl);
      const notes = req.body.notes || null;
      try {
        const result = await recordProofExecutionEvent({
          organizationId,
          actorUserId: actor.actorUserId,
          driverProfileId: actor.driverProfileId,
          role: actor.role,
          assistedRouteId: actor.assistedRouteId,
          assistedDriverId: actor.assistedDriverId,
          stopId: id,
          clientEventId,
          planVersion: executionMetadata.planVersion,
          occurredAt: executionMetadata.occurredAt,
          proof: {
            proofType: "photo",
            proofStage,
            fileUrl,
            data: null,
            notes,
            contentHash: createHash("sha256").update(file.buffer).digest("hex"),
          },
        });
        if (result.duplicate && result.proof.fileUrl !== fileUrl) {
          await storageService.deleteObjectEntity(fileUrl).catch(() => {});
        }
        res.status(result.duplicate ? 200 : 201).json(result.proof);
      } catch (error) {
        await storageService.deleteObjectEntity(fileUrl).catch(() => {});
        throw error;
      }
      return;
    }

    const { proofType, data, notes } = req.body;

    if (!proofType || !["photo", "signature", "barcode"].includes(proofType)) {
      res.status(400).json({ error: "proofType must be 'photo', 'signature', or 'barcode'" });
      return;
    }

    let fileUrl: string | null = null;
    let contentHash: string;

    if (proofType === "photo" || proofType === "signature") {
      if (!data) {
        res.status(400).json({ error: "data (base64) is required for photo/signature proofs, or upload as multipart form with 'photo' field" });
        return;
      }

      const base64Data = data.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      contentHash = createHash("sha256").update(buffer).digest("hex");

      const scan = validateAndScanImage({ buffer });
      if (!scan.ok) {
        logUploadRejected(req, scan.error, id).catch(() => {});
        res.status(scan.status).json({ error: scan.error });
        return;
      }

      const storageService = new ObjectStorageService();
      const uploadUrl = await storageService.getObjectEntityUploadURL();

      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": scan.contentType },
        body: buffer,
      });

      if (!uploadResponse.ok) {
        res.status(502).json({ error: `Failed to upload ${proofType} to storage` });
        return;
      }

      await storageService.trySetObjectEntityAclPolicy(uploadUrl, {
        owner: req.user!.id,
        visibility: "private",
        aclRules: [
          {
            group: { type: ObjectAccessGroupType.ORG_MEMBERS, id: organizationId },
            permission: ObjectPermission.READ,
          },
        ],
      });

      fileUrl = storageService.normalizeObjectEntityPath(uploadUrl);
    } else {
      contentHash = createHash("sha256").update(String(data)).digest("hex");
    }
    try {
      const result = await recordProofExecutionEvent({
        organizationId,
        actorUserId: actor.actorUserId,
        driverProfileId: actor.driverProfileId,
        role: actor.role,
        assistedRouteId: actor.assistedRouteId,
        assistedDriverId: actor.assistedDriverId,
        stopId: id,
        clientEventId,
        planVersion: executionMetadata.planVersion,
        occurredAt: executionMetadata.occurredAt,
        proof: {
          proofType,
          proofStage,
          fileUrl,
          data: proofType === "barcode" ? String(data) : null,
          notes: notes || null,
          contentHash,
        },
      });
      if (result.duplicate && fileUrl && result.proof.fileUrl !== fileUrl) {
        const storageService = new ObjectStorageService();
        await storageService.deleteObjectEntity(fileUrl).catch(() => {});
      }
      res.status(result.duplicate ? 200 : 201).json(result.proof);
    } catch (error) {
      if (fileUrl) {
        const storageService = new ObjectStorageService();
        await storageService.deleteObjectEntity(fileUrl).catch(() => {});
      }
      throw error;
    }
  } catch (err) {
    if (err instanceof ExecutionEventError || err instanceof DriverAssistanceError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleError(res, err);
  }
});

router.get("/stops/:id/proofs", requireProofReadAccess(), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const organizationId = req.user!.organizationId;

    if (!organizationId) {
      res.status(400).json({ error: "organizationId query parameter is required" });
      return;
    }

    const stop = await verifyStopAccess(id, organizationId);
    if (!stop) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }

    const proofs = await db
      .select()
      .from(deliveryProofsTable)
      .where(eq(deliveryProofsTable.stopId, id));

    res.json(proofs);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
