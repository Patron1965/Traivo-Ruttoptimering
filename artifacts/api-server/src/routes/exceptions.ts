import { Router, json, type IRouter, type Request, type Response, type NextFunction } from "express";
import { createHash } from "node:crypto";
import multer from "multer";
import { z } from "zod/v4";
import { db } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";
import { ObjectAccessGroupType, ObjectPermission } from "../lib/objectAcl";
import { ObjectStorageService } from "../lib/objectStorage";
import { logUploadRejected } from "../lib/security-log";
import { validateAndScanImage } from "../lib/file-scan";
import {
  ExecutionEventError,
  recordProofExecutionEvent,
  validateExecutionEventContext,
} from "../services/execution-event-service";
import { getOrgId } from "../middleware/auth";
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
    cb(null, file.mimetype.startsWith("image/"));
  },
});
const jsonParser = json({ limit: "12mb" });

const ExceptionMetadata = z.object({
  category: z.enum([
    "traffic",
    "vehicle_issue",
    "accident",
    "customer_unavailable",
    "access_problem",
    "weather",
    "safety",
    "other",
  ]),
  comment: z.string().trim().min(1).max(4000),
  proofStage: z.enum(["pickup", "delivery"]).default("delivery"),
  clientEventId: z.string().trim().min(1).max(200),
  planVersion: z.coerce.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
  photoData: z.string().optional(),
});

function parseBody(req: Request, res: Response, next: NextFunction) {
  if ((req.headers["content-type"] ?? "").includes("multipart/form-data")) {
    photoUpload.single("photo")(req, res, (error: unknown) => {
      if (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Invalid exception photo" });
        return;
      }
      next();
    });
  } else {
    jsonParser(req, res, next);
  }
}

router.post("/stops/:id/exceptions", parseBody, async (req, res) => {
  let fileUrl: string | null = null;
  let storageService: ObjectStorageService | null = null;
  try {
    const { id } = parseUuidParam(req.params);
    const metadata = ExceptionMetadata.parse(req.body ?? {});
    const uploaded = (req as Request & { file?: Express.Multer.File }).file;
    if (!uploaded && !metadata.photoData) {
      res.status(400).json({ error: "A photo file or photoData is required" });
      return;
    }
    const organizationId = getOrgId(req);
    const actor = executionActorForRequest(req, getDriverAssistanceContext(req));
    await validateExecutionEventContext({
      organizationId,
      driverProfileId: actor.driverProfileId,
      role: actor.role,
      stopId: id,
      planVersion: metadata.planVersion,
      assistedRouteId: actor.assistedRouteId,
      assistedDriverId: actor.assistedDriverId,
    });

    let buffer: Buffer;
    let contentType: string | undefined;
    if (uploaded) {
      buffer = uploaded.buffer;
      contentType = uploaded.mimetype;
    } else {
      const base64Data = metadata.photoData!.replace(/^data:[^;]+;base64,/, "");
      buffer = Buffer.from(base64Data, "base64");
    }
    const scan = validateAndScanImage({ buffer, declaredType: contentType });
    if (!scan.ok) {
      logUploadRejected(req, scan.error, id).catch(() => {});
      res.status(scan.status).json({ error: scan.error });
      return;
    }

    storageService = new ObjectStorageService();
    const uploadUrl = await storageService.getObjectEntityUploadURL();
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": scan.contentType },
      body: buffer,
    });
    if (!uploadResponse.ok) {
      res.status(502).json({ error: "Failed to upload exception photo to storage" });
      return;
    }
    await storageService.trySetObjectEntityAclPolicy(uploadUrl, {
      owner: req.user!.id,
      visibility: "private",
      aclRules: [{
        group: { type: ObjectAccessGroupType.ORG_MEMBERS, id: organizationId },
        permission: ObjectPermission.READ,
      }],
    });
    fileUrl = storageService.normalizeObjectEntityPath(uploadUrl);

    const result = await recordProofExecutionEvent({
      organizationId,
      actorUserId: actor.actorUserId,
      driverProfileId: actor.driverProfileId,
      role: actor.role,
      assistedRouteId: actor.assistedRouteId,
      assistedDriverId: actor.assistedDriverId,
      stopId: id,
      clientEventId: metadata.clientEventId,
      planVersion: metadata.planVersion,
      occurredAt: metadata.occurredAt,
      proof: {
        proofType: "photo",
        proofStage: metadata.proofStage,
        fileUrl,
        data: null,
        notes: `${metadata.category}: ${metadata.comment}`,
        contentHash: createHash("sha256").update(buffer).digest("hex"),
      },
    });
    if (result.duplicate && result.proof.fileUrl !== fileUrl) {
      await storageService.deleteObjectEntity(fileUrl).catch(() => {});
    }
    res.status(result.duplicate ? 200 : 201).json({
      ...result.proof,
      attachmentUrl: result.proof.fileUrl,
      category: metadata.category,
      comment: metadata.comment,
    });
  } catch (error) {
    if (fileUrl && storageService) {
      await storageService.deleteObjectEntity(fileUrl).catch(() => {});
    }
    if (error instanceof ExecutionEventError || error instanceof DriverAssistanceError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    handleError(res, error);
  }
});

export default router;