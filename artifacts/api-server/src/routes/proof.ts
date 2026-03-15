import { Router, json, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import multer from "multer";
import { db, stopsTable, deliveryProofsTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";
import { ObjectStorageService } from "../lib/objectStorage";

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

function flexibleParser(req: Request, res: Response, next: NextFunction) {
  const ct = req.headers["content-type"] || "";
  if (ct.includes("multipart/form-data")) {
    photoUpload.single("photo")(req, res, next);
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
    const organizationId = req.query.organizationId as string | undefined;

    if (!organizationId) {
      res.status(400).json({ error: "organizationId query parameter is required" });
      return;
    }

    const stop = await verifyStopAccess(id, organizationId);
    if (!stop) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }

    const file = (req as Request & { file?: Express.Multer.File }).file;

    if (file) {
      const storageService = new ObjectStorageService();
      const uploadUrl = await storageService.getObjectEntityUploadURL();

      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.mimetype },
        body: file.buffer,
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
      return;
    }

    const { proofType, data, notes } = req.body;

    if (!proofType || !["photo", "signature", "barcode"].includes(proofType)) {
      res.status(400).json({ error: "proofType must be 'photo', 'signature', or 'barcode'" });
      return;
    }

    let fileUrl: string | null = null;

    if (proofType === "photo" || proofType === "signature") {
      if (!data) {
        res.status(400).json({ error: "data (base64) is required for photo/signature proofs, or upload as multipart form with 'photo' field" });
        return;
      }

      const storageService = new ObjectStorageService();
      const uploadUrl = await storageService.getObjectEntityUploadURL();

      const base64Data = data.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      const contentType = proofType === "signature" ? "image/png" : "image/jpeg";

      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: buffer,
      });

      if (!uploadResponse.ok) {
        res.status(502).json({ error: `Failed to upload ${proofType} to storage` });
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
