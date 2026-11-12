import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { eq, and, desc, lt } from "drizzle-orm";
import { db, documentsTable, documentUploadIntentsTable } from "@workspace/db";
import { assertOrgScope, getOrgId } from "../middleware/auth";
import { handleError, parseUuidParam } from "../lib/errors";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  ObjectPermission,
  ObjectAccessGroupType,
} from "../lib/objectAcl";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
];
const INTENT_TTL_MS = 15 * 60 * 1000; // 15 minutes

const RequestDocUploadUrlBody = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  contentType: z
    .string()
    .min(1)
    .refine((t) => ALLOWED_CONTENT_TYPES.includes(t), {
      message: "Unsupported content type",
    }),
});

const RegisterDocumentBody = z.object({
  intentId: z.guid(),
  name: z.string().min(1).max(255),
});

/**
 * POST /documents/upload-url
 *
 * Issues a presigned upload URL for a document and persists a short-lived
 * intent record that binds the resulting object path to this user + org.
 * The intent must be consumed by POST /documents within 15 minutes.
 */
router.post("/documents/upload-url", async (req: Request, res: Response) => {
  try {
    const orgId = getOrgId(req);
    const userId = req.user!.id;

    const parsed = RequestDocUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid required fields" });
      return;
    }

    const { name, size, contentType } = parsed.data;

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    const expiresAt = new Date(Date.now() + INTENT_TTL_MS);

    const [intent] = await db
      .insert(documentUploadIntentsTable)
      .values({
        organizationId: orgId,
        userId,
        objectPath,
        name,
        contentType,
        sizeBytes: size,
        expiresAt,
      })
      .returning({ id: documentUploadIntentsTable.id });

    res.json({ uploadURL, intentId: intent.id });
  } catch (error) {
    console.error("Error generating document upload URL:", error);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * GET /documents
 * List all documents for the authenticated user's organization.
 */
router.get("/documents", async (req: Request, res: Response) => {
  try {
    const orgId = assertOrgScope(req, req.query.organizationId);

    const docs = await db
      .select({
        id: documentsTable.id,
        name: documentsTable.name,
        fileUrl: documentsTable.fileUrl,
        contentType: documentsTable.contentType,
        sizeBytes: documentsTable.sizeBytes,
        uploadedBy: documentsTable.uploadedBy,
        createdAt: documentsTable.createdAt,
      })
      .from(documentsTable)
      .where(eq(documentsTable.organizationId, orgId))
      .orderBy(desc(documentsTable.createdAt));

    res.json({ documents: docs });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * POST /documents
 *
 * Registers a document after the file has been uploaded to object storage.
 * Requires a valid, unused, unexpired intent ID that was issued to this
 * user + org by POST /documents/upload-url. The intent is consumed atomically
 * so it cannot be reused. ACL assignment is mandatory — creation fails if it
 * cannot be applied.
 */
router.post("/documents", async (req: Request, res: Response) => {
  try {
    const orgId = getOrgId(req);
    const userId = req.user!.id;

    const parsed = RegisterDocumentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid fields", details: parsed.error.issues });
      return;
    }

    const { intentId, name } = parsed.data;
    const now = new Date();

    // Validate the intent: must belong to this user AND this org, not expired, not used
    const [intent] = await db
      .select()
      .from(documentUploadIntentsTable)
      .where(
        and(
          eq(documentUploadIntentsTable.id, intentId),
          eq(documentUploadIntentsTable.userId, userId),
          eq(documentUploadIntentsTable.organizationId, orgId),
        ),
      )
      .limit(1);

    if (!intent) {
      res.status(400).json({ error: "Invalid upload intent" });
      return;
    }
    if (intent.usedAt !== null) {
      res.status(400).json({ error: "Upload intent already used" });
      return;
    }
    if (intent.expiresAt < now) {
      res.status(400).json({ error: "Upload intent has expired" });
      return;
    }

    // Mark the intent as consumed before any further work to prevent replay
    const [consumed] = await db
      .update(documentUploadIntentsTable)
      .set({ usedAt: now })
      .where(
        and(
          eq(documentUploadIntentsTable.id, intentId),
          // Extra guard: only consume if still unused (race-condition safety)
          eq(documentUploadIntentsTable.usedAt, null as unknown as Date),
        ),
      )
      .returning({ id: documentUploadIntentsTable.id });

    if (!consumed) {
      res.status(400).json({ error: "Upload intent already used" });
      return;
    }

    const { objectPath, contentType, sizeBytes } = intent;

    // Verify the actual uploaded object matches the declared metadata.
    // This prevents MIME-type substitution and size-limit bypasses that
    // the presigned URL alone cannot enforce.
    let objectFile;
    try {
      objectFile = await objectStorageService.getObjectEntityFile(objectPath);
    } catch {
      res.status(400).json({ error: "Uploaded file not found in storage" });
      return;
    }
    const [objectMetadata] = await objectFile.getMetadata();
    const actualContentType = (objectMetadata.contentType as string | undefined) ?? "";
    const actualSize = Number(objectMetadata.size ?? 0);

    if (!ALLOWED_CONTENT_TYPES.includes(actualContentType)) {
      // Object has an unacceptable MIME type — delete it and reject
      await objectFile.delete().catch(() => {});
      res.status(400).json({ error: "Uploaded file has an unsupported content type" });
      return;
    }
    if (actualContentType !== contentType) {
      // Client declared one type, uploaded another — reject
      await objectFile.delete().catch(() => {});
      res.status(400).json({ error: "Uploaded file content type does not match declaration" });
      return;
    }
    if (actualSize > MAX_UPLOAD_BYTES) {
      // File exceeds the size limit
      await objectFile.delete().catch(() => {});
      res.status(400).json({ error: "Uploaded file exceeds the maximum size limit" });
      return;
    }
    if (Math.abs(actualSize - sizeBytes) > 1024) {
      // Actual size deviates more than 1 KB from the declared size — reject
      await objectFile.delete().catch(() => {});
      res.status(400).json({ error: "Uploaded file size does not match declaration" });
      return;
    }

    // Set ACL — this is mandatory. If it fails we refuse to create the record
    // so the document is never accessible to unintended parties.
    try {
      await objectStorageService.trySetObjectEntityAclPolicy(objectPath, {
        owner: userId,
        visibility: "private",
        aclRules: [
          {
            group: { type: ObjectAccessGroupType.ORG_MEMBERS, id: orgId },
            permission: ObjectPermission.READ,
          },
        ],
      });
    } catch (aclErr) {
      console.error("Failed to set ACL on document object, aborting creation:", aclErr);
      res.status(500).json({ error: "Failed to secure document. Please try again." });
      return;
    }

    const [doc] = await db
      .insert(documentsTable)
      .values({
        organizationId: orgId,
        uploadedBy: userId,
        name,
        fileUrl: objectPath,
        contentType,
        sizeBytes,
      })
      .returning();

    res.status(201).json({ document: doc });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * DELETE /documents/:id
 *
 * Deletes the storage object first (revoking all access), then removes the
 * DB record. If the storage deletion fails the DB record is kept and an error
 * is returned so the caller knows the document is still accessible.
 * Admins can delete any document; dispatchers only their own uploads.
 */
router.delete("/documents/:id", async (req: Request, res: Response) => {
  try {
    const orgId = getOrgId(req);
    const { id } = parseUuidParam(req.params as Record<string, string>);

    const [doc] = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.organizationId, orgId)))
      .limit(1);

    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const role = req.user!.role;
    if (role !== "admin" && doc.uploadedBy !== req.user!.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // Delete the storage object first so access is revoked immediately.
    // If this fails (non-404), abort — we must not leave an orphaned record
    // pointing at an object the user believes is gone.
    try {
      await objectStorageService.deleteObjectEntity(doc.fileUrl);
    } catch (storageErr) {
      console.error("Failed to delete document object from storage:", storageErr);
      res.status(500).json({ error: "Failed to delete document from storage. Please try again." });
      return;
    }

    await db
      .delete(documentsTable)
      .where(and(eq(documentsTable.id, id), eq(documentsTable.organizationId, orgId)));

    res.status(204).end();
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
