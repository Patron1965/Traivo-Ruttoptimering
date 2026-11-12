import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  planningDraftsTable,
  routesTable,
  type PlanningDraft,
  type PlanningDraftState,
} from "@workspace/db";

// An operational import keeps every source column/row in the resumable draft.
// 8,660 x 18 cells are already ~2 MB as JSON, before mapping adds a second
// representation of those rows. Stay below the global 20 MB JSON parser limit.
export const DRAFT_STATE_MAX_BYTES = 16 * 1024 * 1024;
export const DRAFT_BODY_MAX_BYTES = 18 * 1024 * 1024;

export class PlanningDraftError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 413 = 400,
    readonly code?: string,
    readonly draft?: PlanningDraft,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PlanningDraftError";
  }
}

function jsonSafe(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonSafe);
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .every(([key, entry]) => typeof key === "string" && jsonSafe(entry));
  }
  return false;
}

export function assertDraftState(state: unknown): asserts state is PlanningDraftState {
  if (
    !state
    || typeof state !== "object"
    || Array.isArray(state)
    || !jsonSafe(state)
  ) {
    throw new PlanningDraftError("state must be a JSON object.", 400, "INVALID_DRAFT_STATE");
  }
  const bytes = Buffer.byteLength(JSON.stringify(state), "utf8");
  if (bytes > DRAFT_STATE_MAX_BYTES) {
    throw new PlanningDraftError(
      `state exceeds the ${DRAFT_STATE_MAX_BYTES} byte limit.`,
      413,
      "DRAFT_STATE_TOO_LARGE",
    );
  }
}

function planningMaterialState(state: PlanningDraftState): unknown {
  const metadata = state.planningMetadata;
  return {
    planningInputs: state.planningInputs ?? null,
    sharedInstructions: metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).sharedInstructions ?? null
      : null,
  };
}

function customerReferenceFromState(state: PlanningDraftState): string | null {
  const metadata = state.planningMetadata;
  const value = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).customerReference
    : null;
  if (value == null) return null;
  if (typeof value !== "string" || value.trim().length > 200) {
    throw new PlanningDraftError("customerReference must be a string of at most 200 characters.", 400, "INVALID_DRAFT_STATE");
  }
  return value.trim() || null;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

/**
 * Hash only server-validated values. This is deliberately not a client supplied
 * idempotency key: the draft row is locked before a write is accepted.
 */
export function payloadIdentityHash(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(sortJson(value)))
    .digest("hex");
}

export function draftForResponse(draft: PlanningDraft) {
  return {
    id: draft.id,
    organizationId: draft.organizationId,
    name: draft.name,
    startAt: draft.startAt,
    state: draft.state,
    revision: draft.revision,
    importedResult: draft.importedResult ?? null,
    planId: draft.planId ?? null,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

function retainAppendMembership(state: PlanningDraftState, previous?: PlanningDraftState): PlanningDraftState {
  const result = { ...state };
  delete result.dispatchSourceStopIds;
  if (Array.isArray(previous?.dispatchSourceStopIds)) result.dispatchSourceStopIds = previous.dispatchSourceStopIds;
  delete result.appendedStopIds;
  if (Array.isArray(previous?.appendedStopIds)) result.appendedStopIds = previous.appendedStopIds;
  return result;
}

export async function listPlanningDrafts(organizationId: string) {
  const drafts = await db
    .select()
    .from(planningDraftsTable)
    .where(eq(planningDraftsTable.organizationId, organizationId))
    .orderBy(desc(planningDraftsTable.updatedAt));
  return drafts.map(draftForResponse);
}

export async function getPlanningDraft(organizationId: string, id: string) {
  const [draft] = await db
    .select()
    .from(planningDraftsTable)
    .where(and(
      eq(planningDraftsTable.id, id),
      eq(planningDraftsTable.organizationId, organizationId),
    ))
    .limit(1);
  return draft ? draftForResponse(draft) : null;
}

export async function createPlanningDraft(input: {
  organizationId: string;
  name: string;
  startAt: Date;
  state: PlanningDraftState;
}) {
  const [draft] = await db.insert(planningDraftsTable).values({
    organizationId: input.organizationId,
    name: input.name,
    startAt: input.startAt,
    state: retainAppendMembership(input.state),
  }).returning();
  return draftForResponse(draft);
}

export async function updatePlanningDraft(input: {
  organizationId: string;
  id: string;
  revision: number;
  name?: string;
  startAt?: Date;
  state?: PlanningDraftState;
}) {
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(planningDraftsTable)
      .where(and(
        eq(planningDraftsTable.id, input.id),
        eq(planningDraftsTable.organizationId, input.organizationId),
      ))
      .limit(1)
      .for("update");
    if (!draft) {
      throw new PlanningDraftError("Planning draft not found.", 404, "DRAFT_NOT_FOUND");
    }
    if (draft.revision !== input.revision) {
      throw new PlanningDraftError(
        "The planning draft changed. Reload it before saving.",
        409,
        "DRAFT_REVISION_CONFLICT",
        draft,
      );
    }
    if (
      draft.planId
      && (input.name !== undefined || input.startAt !== undefined)
    ) {
      throw new PlanningDraftError(
        "A planning draft's name and startAt cannot change after route planning.",
        409,
        "DRAFT_FROZEN",
        draft,
      );
    }
    if (draft.planId && input.state !== undefined) {
      const nextState = input.state;
      if (payloadIdentityHash(planningMaterialState(draft.state)) !== payloadIdentityHash(planningMaterialState(nextState))) {
        throw new PlanningDraftError(
          "Planning inputs and shared instructions on a generated plan must use protected reoptimization.",
          409,
          "DRAFT_FROZEN",
          draft,
        );
      }
      const previousReference = customerReferenceFromState(draft.state);
      const nextReference = customerReferenceFromState(nextState);
      if (previousReference !== nextReference) {
        await tx.update(routesTable).set({
          customerReference: nextReference,
          updatedAt: new Date(),
        }).where(and(
          eq(routesTable.organizationId, input.organizationId),
          eq(routesTable.planId, draft.planId),
        ));
      }
    }

    const [updated] = await tx
      .update(planningDraftsTable)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.startAt === undefined ? {} : { startAt: input.startAt }),
        ...(input.state === undefined ? {} : { state:
          // Append membership is server-owned additive evidence, like the
          // original importedResult. An older tab must not erase or forge it.
          retainAppendMembership(input.state, draft.state),
        }),
        revision: draft.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(
        eq(planningDraftsTable.id, input.id),
        eq(planningDraftsTable.organizationId, input.organizationId),
        eq(planningDraftsTable.revision, input.revision),
      ))
      .returning();
    if (!updated) {
      const [current] = await tx
        .select()
        .from(planningDraftsTable)
        .where(and(
          eq(planningDraftsTable.id, input.id),
          eq(planningDraftsTable.organizationId, input.organizationId),
        ))
        .limit(1);
      throw new PlanningDraftError(
        "The planning draft changed. Reload it before saving.",
        409,
        "DRAFT_REVISION_CONFLICT",
        current,
      );
    }
    return draftForResponse(updated);
  });
}
