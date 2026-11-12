import { Router, type IRouter } from "express";
import { z } from "zod";
import { getOrgId, requireRole } from "../middleware/auth";
import { handleError } from "../lib/errors";
import { recommendPlannerResources, previewPlannerAddress, confirmPlannerCorrection } from "../services/planner-correction-service";
import { replaceRouteResources } from "../services/route-service";

const router: IRouter = Router();
router.use("/planner-corrections", requireRole("admin", "dispatcher"));
const recommendationBody = z.object({
  stopId: z.guid(), routeIds: z.array(z.guid()).min(1).max(30),
}).strict();
const addressBody = z.object({
  stopId: z.guid(), address: z.string().trim().min(3).max(500),
  position: z.object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180), confirmed: z.literal(true),
  }).strict().optional(),
}).strict();
const confirmBody = z.object({ token: z.string().min(1).max(100_000), confirmed: z.literal(true) }).strict();
const resourceBody = z.object({
  routeId: z.guid(), vehicleId: z.guid(), driverId: z.guid(),
  planRevision: z.number().int().min(0), force: z.boolean().optional(),
  expectedPreviewDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

for (const previewOnly of [true, false]) {
  router.post(`/planner-corrections/route-resources/${previewOnly ? "preview" : "confirm"}`, async (req, res): Promise<void> => {
    try {
      const input = resourceBody.parse(req.body);
      if (!previewOnly && !input.expectedPreviewDigest) {
        res.status(400).json({ error: "Förhandsgranska resursbytet före bekräftelse." }); return;
      }
      const result = await replaceRouteResources(getOrgId(req), input, {
        previewOnly, actor: { userId: req.user!.id, userEmail: req.user!.email },
      });
      if (!result) { res.status(404).json({ error: "Rutten hittades inte." }); return; }
      res.json(result);
    } catch (error) { handleError(res, error); }
  });
}

router.post("/planner-corrections/recommendations", async (req, res): Promise<void> => {
  try {
    const input = recommendationBody.parse(req.body);
    res.json(await recommendPlannerResources(getOrgId(req), { userId: req.user!.id }, input.stopId, input.routeIds));
  } catch (error) { handleError(res, error); }
});
router.post("/planner-corrections/address/preview", async (req, res): Promise<void> => {
  try {
    const input = addressBody.parse(req.body);
    res.json(await previewPlannerAddress(getOrgId(req), { userId: req.user!.id }, input));
  } catch (error) { handleError(res, error); }
});
router.post("/planner-corrections/confirm", async (req, res): Promise<void> => {
  try {
    const input = confirmBody.parse(req.body);
    res.json(await confirmPlannerCorrection(getOrgId(req), {
      userId: req.user!.id, userEmail: req.user!.email,
    }, input.token));
  } catch (error) { handleError(res, error); }
});
export default router;
