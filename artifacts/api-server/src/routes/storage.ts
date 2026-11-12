import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { db, deliveryProofsTable, stopsTable } from "@workspace/db";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import {
  ObjectPermission,
  ObjectAccessGroupType,
  getObjectAclPolicy,
} from "../lib/objectAcl";
import { verifyDriverStopOwnership } from "../services/field-service";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
];

const RequestUploadUrlBody = z.object({
  name: z.string().min(1),
  size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  contentType: z.string().min(1).refine((t) => ALLOWED_UPLOAD_TYPES.includes(t), {
    message: "Unsupported content type",
  }),
});

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * Returns the owning organization id of a private object if (and only if) it is
 * referenced by a delivery-proof record. Used to grant legacy proof objects
 * (uploaded before ACL enforcement) read access scoped to their org.
 */
async function getProofObjectContext(
  objectPath: string,
): Promise<{ organizationId: string; stopId: string } | null> {
  const rows = await db
    .select({
      organizationId: stopsTable.organizationId,
      stopId: stopsTable.id,
    })
    .from(deliveryProofsTable)
    .innerJoin(stopsTable, eq(deliveryProofsTable.stopId, stopsTable.id))
    .where(eq(deliveryProofsTable.fileUrl, objectPath))
    .limit(1);
  return rows[0] ?? null;
}

router.post("/storage/uploads/request-url", async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { name, size, contentType } = parsed.data;

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json({ uploadURL, objectPath, metadata: { name, size, contentType } });
  } catch (error) {
    console.error("Error generating upload URL:", error);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error("Error serving public object:", error);
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const proofContext = await getProofObjectContext(objectPath);
    if (proofContext) {
      if (
        proofContext.organizationId !== req.user.organizationId ||
        req.user.role === "viewer"
      ) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (req.user.role === "driver") {
        if (!req.user.driverProfileId) {
          res.status(403).json({ error: "Forbidden" });
          return;
        }
        const ownershipError = await verifyDriverStopOwnership(
          proofContext.stopId,
          req.user.organizationId,
          req.user.driverProfileId,
        );
        if (ownershipError) {
          res.status(403).json({ error: "Forbidden" });
          return;
        }
      }
    }

    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
    let canAccess = await objectStorageService.canAccessObjectEntity({
      authenticatedOrganizationId: req.user.organizationId,
      workspaceOrganizationId: req.user.workspace?.organizationId,
      userId: req.user.id,
      objectFile,
      requestedPermission: ObjectPermission.READ,
    });

    // Legacy compatibility: proof files uploaded before ACL enforcement carry no
    // ACL metadata, which canAccessObjectEntity hard-denies. Fall back to the
    // delivery-proof record's org ownership (strictly scoped to proof objects),
    // then lazily backfill the ACL so future reads use the standard path.
    if (!canAccess) {
      const aclPolicy = await getObjectAclPolicy(objectFile);
      if (!aclPolicy) {
        const orgId = proofContext?.organizationId ?? null;
        if (orgId && orgId === req.user.organizationId) {
          canAccess = true;
          await objectStorageService
            .trySetObjectEntityAclPolicy(objectPath, {
              owner: req.user.id,
              visibility: "private",
              aclRules: [
                {
                  group: { type: ObjectAccessGroupType.ORG_MEMBERS, id: orgId },
                  permission: ObjectPermission.READ,
                },
              ],
            })
            .catch(() => {});
        }
      }
    }

    if (!canAccess) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.setHeader("Cache-Control", "no-store");

    // Force download — never render private objects inline to prevent XSS
    res.setHeader("Content-Disposition", "attachment");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error("Error serving object:", error);
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
