import { Router, json, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import multer from "multer";
import { db, stopsTable, deliveryProofsTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/heic"];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported image format"));
    }
  },
});

const largeJsonParser = json({ limit: "5mb" });

async function verifyStopAccess(stopId: string, organizationId?: string) {
  const conditions = [eq(stopsTable.id, stopId)];
  if (organizationId) {
    conditions.push(eq(stopsTable.organizationId, organizationId));
  }
  const [stop] = await db.select().from(stopsTable).where(and(...conditions));
  return stop || null;
}

router.post("/stops/:id/proof/photo", upload.single("photo"), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const organizationId = req.query.organizationId as string | undefined;
    const stop = await verifyStopAccess(id, organizationId);
    if (!stop) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "photo file is required" });
      return;
    }

    const storageService = new ObjectStorageService();
    const uploadUrl = await storageService.getObjectEntityUploadURL();

    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": req.file.mimetype },
      body: req.file.buffer,
    });

    if (!uploadResponse.ok) {
      res.status(502).json({ error: "Failed to upload photo to storage" });
      return;
    }

    const fileUrl = storageService.normalizeObjectEntityPath(uploadUrl);
    const notes = req.body.notes || null;

    const [proof] = await db.insert(deliveryProofsTable).values({
      stopId: id,
      proofType: "photo",
      fileUrl,
      data: null,
      notes,
    }).returning();

    res.status(201).json(proof);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/stops/:id/proof", largeJsonParser, async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const organizationId = req.query.organizationId as string | undefined;
    const stop = await verifyStopAccess(id, organizationId);
    if (!stop) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }

    const { proofType, data, notes } = req.body;

    if (!proofType || !["signature", "barcode"].includes(proofType)) {
      res.status(400).json({ error: "proofType must be 'signature' or 'barcode'. Use POST /stops/:id/proof/photo for photo uploads." });
      return;
    }

    let fileUrl: string | null = null;

    if (proofType === "signature") {
      if (!data) {
        res.status(400).json({ error: "data (base64) is required for signature proofs" });
        return;
      }

      const storageService = new ObjectStorageService();
      const uploadUrl = await storageService.getObjectEntityUploadURL();

      const base64Data = data.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");

      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: buffer,
      });

      if (!uploadResponse.ok) {
        res.status(502).json({ error: "Failed to upload signature to storage" });
        return;
      }

      fileUrl = storageService.normalizeObjectEntityPath(uploadUrl);
    }

    const [proof] = await db.insert(deliveryProofsTable).values({
      stopId: id,
      proofType,
      fileUrl,
      data: proofType === "barcode" ? data : null,
      notes: notes || null,
    }).returning();

    res.status(201).json(proof);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/stops/:id/proofs", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const organizationId = req.query.organizationId as string | undefined;
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
