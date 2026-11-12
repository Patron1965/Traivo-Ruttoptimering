import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const map = read("../components/map/RouteMap.tsx");
const bulk = read("../components/dispatch/DispatchBulkActions.tsx");
const page = read("../pages/Dispatch.tsx");

test("polygon has visible completion, a three-vertex gate, and cancellation without committing selection", () => {
  assert.match(map, /data-testid="dispatch-finish-marking" disabled=\{vertices.length < 3\}/);
  assert.match(map, /Slutför markering/);
  assert.match(map, /data-testid="dispatch-cancel-marking" onClick=\{onCancel\}/);
  assert.match(map, /event.key === "Enter" && vertices.length >= 3/);
  assert.match(map, /const cancelMarking = useCallback\(\(\) => setMarking\(false\), \[\]\)/);
  assert.match(map, /if \(ids.length\) onPolygonSelect\?\.\(ids\)/);
  assert.match(map, /Inga stopp finns i markeringen/);
  assert.match(map, /L.DomEvent.disableClickPropagation/);
});

test("both Dispatch variants open explicit polygon review with no preselected route", () => {
  assert.equal(page.split('setMapRouteRequest({ origin: "polygon", routeId: null, nonce: Date.now() })').length - 1, 2);
  assert.equal(page.split("routeDriverNames={dispatchRouteDriverNames(activeRoutes, drivers ?? [], approvalQuery.error ? undefined : approvalQuery.data)}").length - 1, 2);
  assert.match(bulk, /routeRequest.origin === "polygon" \? "route"/);
  assert.match(bulk, /setRouteId\(routeRequest.routeId \?\? ""\); setOpen\(true\)/);
  assert.match(bulk, /!polygonReview \|\| routeDriverNames.has\(route.id\)/);
  assert.match(bulk, /Flytta till förare och optimera rutten/);
  assert.match(bulk, /Gör oplanerade/);
});

test("optimized intent is included in preview identity, request and digest-bound commit only for polygon route moves", () => {
  assert.match(bulk, /const optimizeTargetRoute = polygonReview && action === "route"/);
  assert.match(bulk, /action, routeId, optimizeTargetRoute, targetIndex/);
  assert.match(bulk, /routeRevisions,\s+optimizeTargetRoute,/);
  assert.match(bulk, /routePreview\?\.previewDigest, optimizeTargetRoute\)/);
  assert.match(bulk, /canConfirmPlanningDeviation\(routePreview.conflicts\)/);
  const hook = read("../hooks/use-dispatch-move.ts");
  assert.match(hook, /optimizeTargetRoute = false/);
  assert.match(hook, /expectedPreviewDigest, optimizeTargetRoute/);
  const drag = read("../hooks/use-direct-dispatch-drag.ts");
  assert.match(drag, /JSON.stringify\(\{ \.\.\.payload, optimizeTargetRoute: false \}\)/);
  assert.match(drag, /payload.targetIndex, false, digest, false\)/);
});
