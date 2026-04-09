import { Router, type IRouter } from "express";
import { CreateStopBody, UpdateStopBody, ListStopsQueryParams, ImportStopsBody } from "@workspace/api-zod";
import { handleError, parseUuidParam } from "../lib/errors";
import { getOrgId } from "../middleware/auth";
import * as stopService from "../services/stop-service";

const router: IRouter = Router();

router.get("/stops", async (req, res) => {
  try {
    const { organizationId, routeId } = ListStopsQueryParams.parse(req.query);
    const orgId = req.user?.organizationId ?? organizationId;
    const stops = await stopService.listStops(orgId, routeId);
    res.json(stops);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/stops/import", async (req, res) => {
  try {
    const data = ImportStopsBody.parse(req.body);
    const orgId = req.user?.organizationId ?? data.organizationId;
    const created = await stopService.importStops(orgId, data.stops);
    res.status(201).json({ imported: created.length, stops: created });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/stops/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const stop = await stopService.getStop(id, orgId);
    if (!stop) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }
    res.json(stop);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/stops", async (req, res) => {
  try {
    const data = CreateStopBody.parse(req.body);
    if (req.user) {
      data.organizationId = req.user.organizationId;
    }
    const contactFields: Record<string, string> = {};
    if (typeof req.body.contactName === "string") contactFields.contactName = req.body.contactName;
    if (typeof req.body.contactEmail === "string") contactFields.contactEmail = req.body.contactEmail;
    const stop = await stopService.createStop({ ...data, ...contactFields });
    res.status(201).json(stop);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/stops/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const data = UpdateStopBody.parse(req.body);
    const contactFields: Record<string, string | null> = {};
    if (typeof req.body.contactName === "string" || req.body.contactName === null) contactFields.contactName = req.body.contactName;
    if (typeof req.body.contactEmail === "string" || req.body.contactEmail === null) contactFields.contactEmail = req.body.contactEmail;
    let orgId: string;
    try {
      orgId = getOrgId(req);
    } catch {
      const existing = await stopService.getStopById(id);
      if (!existing) { res.status(404).json({ error: "Stop not found" }); return; }
      orgId = existing.organizationId;
    }
    const stop = await stopService.updateStop(id, orgId, data, contactFields);
    if (!stop) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }
    res.json(stop);
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/stops/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const deleted = await stopService.deleteStop(id, orgId);
    if (!deleted) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
