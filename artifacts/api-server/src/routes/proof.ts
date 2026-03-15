import { Router, json, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, stopsTable, deliveryProofsTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();

const largeJsonParser = json({ limit: "10mb" });

router.post("/stops/:id/proof", largeJsonParser, async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);

    const [stop] = await db.select().from(stopsTable).where(eq(stopsTable.id, id));
    if (!stop) {
      res.status(404).json({ error: "Stop not found" });
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
        res.status(400).json({ error: "data (base64) is required for photo/signature proofs" });
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
        res.status(502).json({ error: "Failed to upload proof file to storage" });
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
