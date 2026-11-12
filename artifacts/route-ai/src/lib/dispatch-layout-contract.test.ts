import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("main and popout insertion markers use visible indices rather than canonical API indices", () => {
  const page = readFileSync(new URL("../pages/Dispatch.tsx", import.meta.url), "utf8");
  assert.equal(page.split("setDropTargetIndex(id ? (index < 0 ? blocks.length : index) : null)").length - 1, 2);
  assert.ok(page.includes("dropTargetIndexRef.current = canonicalIndex"));
  assert.ok(page.includes("dropTargetIndexRef.current = nextIndex"));
});

test("timeline tooltips close from pointer press through drag and cannot intercept drops", () => {
  const timeline = readFileSync(new URL("../components/dispatch/GanttTimeline.tsx", import.meta.url), "utf8");
  assert.match(timeline, /value=\{pointerPressed \|\| Boolean\(dragState\) \|\| Boolean\(lasso\)\}/);
  assert.match(timeline, /onPointerDownCapture/);
  assert.match(timeline, /open=\{busy \? false : props.open\} disableHoverableContent/);
  assert.match(timeline, /className=\{cn\(className, "pointer-events-none"\)\}/);
  for (const event of ["pointerup", "pointercancel", "blur"]) {
    assert.ok(timeline.includes(`window.addEventListener("${event}", release)`));
    assert.ok(timeline.includes(`window.removeEventListener("${event}", release)`));
  }
});

test("both dispatch views share remaining height between backlog and scrolling timeline", () => {
  const page = readFileSync(new URL("../pages/Dispatch.tsx", import.meta.url), "utf8");
  const timeline = readFileSync(new URL("../components/dispatch/GanttTimeline.tsx", import.meta.url), "utf8");
  const backlog = readFileSync(new URL("../components/dispatch/UnscheduledStopsLane.tsx", import.meta.url), "utf8");
  // Structural regression guard; actual geometry still requires a browser.
  // Each view must be height-bounded (flex-1 or h-full) with min-h-0.
  assert.equal(
    (page.match(/relative flex (?:h-full|flex-1) min-h-0 flex-col bg-card/g) ?? []).length,
    2,
  );
  assert.match(timeline, /flex min-h-0 flex-1 flex-col h-full/);
  assert.match(timeline, /min-h-0 flex-1 overflow-auto/);
  // The backlog lane must not grow into the timeline's share of height.
  assert.match(backlog, /className="(?:flex )?shrink-0 (?:items-center )?border-b/);
});
