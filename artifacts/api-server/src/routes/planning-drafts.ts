import { Router, type IRouter, type Response } from "express";
import {
  CreatePlanningDraftBody,
  CreatePlanningDraftResponse,
  GetPlanningDraftParams,
  GetPlanningDraftResponse,
  ListPlanningDraftsResponse,
  UpdatePlanningDraftBody,
  UpdatePlanningDraftParams,
  UpdatePlanningDraftResponse,
} from "@workspace/api-zod";
import { getOrgId, requireRole } from "../middleware/auth";
import {
  assertDraftState,
  createPlanningDraft,
  DRAFT_BODY_MAX_BYTES,
  draftForResponse,
  getPlanningDraft,
  listPlanningDrafts,
  PlanningDraftError,
  updatePlanningDraft,
} from "../services/planning-draft-service";

const router: IRouter = Router();

function assertBodySize(body: unknown): void {
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  } catch {
    throw new PlanningDraftError("Request body is not valid JSON.", 400, "INVALID_JSON");
  }
  if (bytes > DRAFT_BODY_MAX_BYTES) {
    throw new PlanningDraftError(
      `Request body exceeds the ${DRAFT_BODY_MAX_BYTES} byte limit.`,
      413,
      "DRAFT_BODY_TOO_LARGE",
    );
  }
}

function assertNoServerOwnedFields(body: unknown, allowRevision = false): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const forbidden = ["importedResult", "planId", "organizationId", "revision"];
  const found = forbidden.filter((field) =>
    Object.prototype.hasOwnProperty.call(body, field)
    && (field !== "revision" || !allowRevision));
  if (found.length > 0) {
    throw new PlanningDraftError(
      `Client-owned fields are not accepted: ${found.join(", ")}.`,
      400,
      "SERVER_OWNED_FIELD",
    );
  }
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof PlanningDraftError) {
    res.status(error.statusCode).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.draft ? { draft: draftForResponse(error.draft) } : {}),
    });
    return;
  }
  throw error;
}

router.get("/planning-drafts", requireRole("admin", "dispatcher"), async (req, res): Promise<void> => {
  try {
    const drafts = await listPlanningDrafts(getOrgId(req));
    res.json(ListPlanningDraftsResponse.parse({ drafts }));
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/planning-drafts", requireRole("admin", "dispatcher"), async (req, res): Promise<void> => {
  try {
    assertBodySize(req.body);
    assertNoServerOwnedFields(req.body);
    const parsed = CreatePlanningDraftBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message, code: "INVALID_DRAFT_REQUEST" });
      return;
    }
    if (!parsed.data.name.trim()) {
      res.status(400).json({ error: "name must not be blank.", code: "INVALID_DRAFT_NAME" });
      return;
    }
    assertDraftState(parsed.data.state);
    const draft = await createPlanningDraft({
      organizationId: getOrgId(req),
      name: parsed.data.name.trim(),
      startAt: parsed.data.startAt,
      state: parsed.data.state,
    });
    res.status(201).json(CreatePlanningDraftResponse.parse(draft));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/planning-drafts/:id", requireRole("admin", "dispatcher"), async (req, res): Promise<void> => {
  try {
    const parsed = GetPlanningDraftParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message, code: "INVALID_DRAFT_ID" });
      return;
    }
    const draft = await getPlanningDraft(getOrgId(req), parsed.data.id);
    if (!draft) {
      res.status(404).json({ error: "Planning draft not found.", code: "DRAFT_NOT_FOUND" });
      return;
    }
    res.json(GetPlanningDraftResponse.parse(draft));
  } catch (error) {
    sendError(res, error);
  }
});

router.put("/planning-drafts/:id", requireRole("admin", "dispatcher"), async (req, res): Promise<void> => {
  try {
    assertBodySize(req.body);
    const params = UpdatePlanningDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message, code: "INVALID_DRAFT_ID" });
      return;
    }
    assertNoServerOwnedFields(req.body, true);
    const parsed = UpdatePlanningDraftBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message, code: "INVALID_DRAFT_REQUEST" });
      return;
    }
    if (parsed.data.name !== undefined && !parsed.data.name.trim()) {
      res.status(400).json({ error: "name must not be blank.", code: "INVALID_DRAFT_NAME" });
      return;
    }
    if (parsed.data.state !== undefined) assertDraftState(parsed.data.state);
    const draft = await updatePlanningDraft({
      organizationId: getOrgId(req),
      id: params.data.id,
      revision: parsed.data.revision,
      name: parsed.data.name?.trim(),
      startAt: parsed.data.startAt,
      state: parsed.data.state as Parameters<typeof updatePlanningDraft>[0]["state"],
    });
    res.json(UpdatePlanningDraftResponse.parse(draft));
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
