import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const timeline = readFileSync(
  new URL("../components/dispatch/GanttTimeline.tsx", import.meta.url),
  "utf8",
);

test("stop label visibility depends only on on-screen width", () => {
  assert.match(timeline, /function stopLabelVisible\(blockWidth: number\): boolean \{\s*return blockWidth >= MIN_LABEL_WIDTH_PX;/);
  const calls = timeline.match(/stopLabelVisible\([^)]*\)/g) ?? [];
  const usages = calls.filter((call) => !call.includes("blockWidth: number"));
  assert.equal(usages.length, 4, "all four stop branches use the helper");
  for (const call of usages) assert.equal(call, "stopLabelVisible(blockW)");
});

test("selection and hover never change marker width or scale", () => {
  assert.doesNotMatch(timeline, /scale-110|scale-105/);
  assert.doesNotMatch(timeline, /1\.58|1\.32|1\.14/, "no dock magnification");
  assert.match(timeline, /const getDockScale = \([^)]*\) => 1;/);
  const widths = timeline.match(/width: showStopLabel \? Math\.max\(blockW, 24\) : blockW,/g) ?? [];
  assert.equal(widths.length, 4);
  assert.doesNotMatch(timeline, /isSelected \? Math\.max|isHovered \? Math\.max/);
});

test("fine pointers hit only the visible marker in all four branches", () => {
  assert.match(timeline, /const STOP_HIT_TARGET_CLASS =\s*"[^"]*min-h-\[44px\][^"]*\[@media\(pointer:fine\)\]:pointer-events-none"/);
  assert.match(timeline, /const STOP_VISIBLE_MARKER_HIT_CLASS =\s*"pointer-events-none \[@media\(pointer:fine\)\]:pointer-events-auto"/);
  assert.equal((timeline.match(/className=\{STOP_HIT_TARGET_CLASS\}/g) ?? []).length, 4);
  assert.equal((timeline.match(/STOP_VISIBLE_MARKER_HIT_CLASS, "flex items-center/g) ?? []).length, 4);
  assert.doesNotMatch(timeline, /className="absolute flex items-center justify-center cursor-grab/, "no unguarded 44px target");
  assert.doesNotMatch(timeline, /"pointer-events-none flex items-center justify-center text-\[10px\]/, "visible marker must be hittable");
});

test("one combined proof badge and fixed warning lane in all four branches", () => {
  assert.equal((timeline.match(/<ProofMarker proofTypes=\{stop\.proofTypes\} \/>/g) ?? []).length, 4);
  assert.doesNotMatch(timeline, /<Camera|<PenLine/);
  assert.match(timeline, /data-testid="dispatch-proof-marker"[\s\S]{0,300}absolute -bottom-1 -right-1/);
  const overrideLane = timeline.match(/absolute -right-1 -top-1 z-20 rounded-full/g) ?? [];
  assert.ok(overrideLane.length >= 4, "override warning top-right in every branch");
  assert.doesNotMatch(timeline, /absolute -right-1 -top-1 rounded-full/, "no warning outside the lane");
  const slaLane = timeline.match(/absolute -top-1 -right-1 z-20 w-2 h-2 rounded-full bg-destructive/g) ?? [];
  assert.ok(slaLane.length >= 3, "SLA warning shares the top-right lane");
});

test("stop rectangles stay solid and readable in every status, all four branches", () => {
  assert.doesNotMatch(timeline, /opacity-60 group-hover:opacity-100/, "completed stops are not faded");
  assert.doesNotMatch(timeline, /bg-destructive\/10 text-destructive/, "failed stops are not washed out");
  assert.doesNotMatch(timeline, /bg-red-500\/10 text-red-500/, "warning stops are not washed out");
  assert.equal((timeline.match(/\? STOP_COMPLETED_CLASS/g) ?? []).length, 4);
  assert.equal((timeline.match(/\? STOP_FAILED_CLASS/g) ?? []).length, 4);
  assert.equal((timeline.match(/\.\.\.stopMarkerStyle\(row\.color, isCompleted, isFailed, isForcedOutsideWorkingHours\)/g) ?? []).length, 4);
  assert.doesNotMatch(timeline, /!isSelected &&\s*!isMultiSelected &&\s*!isCompleted/, "selection keeps the vehicle fill");
  assert.equal((timeline.match(/data-testid="dispatch-stop-sequence"/g) ?? []).length, 4);
  assert.equal((timeline.match(/\{showStopLabel && <span data-testid="dispatch-stop-sequence">/g) ?? []).length, 4);
});

test("vehicle-filled tiles take their number colour from the luminance helper", () => {
  assert.match(timeline, /import \{ stopTileText \} from "@\/lib\/stop-tile-contrast";/);
  assert.match(timeline, /function stopMarkerStyle[\s\S]{0,700}\.\.\.stopTileText\(vehicleColor\)/);
  assert.doesNotMatch(timeline, /textShadow: "0 1px 1px rgba\(15, 23, 42, 0\.45\)"/, "no shadow-only contrast");
});

test("breaks are neutral and route lines are subdued", () => {
  assert.doesNotMatch(timeline, /bg-orange-500\/20 border border-orange-500\/30/);
  assert.equal((timeline.match(/className=\{BREAK_BLOCK_CLASS\}/g) ?? []).length, 2);
  assert.match(timeline, /const BREAK_BLOCK_CLASS =\s*"[^"]*bg-muted\/70 text-muted-foreground/);
  assert.match(timeline, /const ROUTE_LINE_HEIGHT = 2;/);
  assert.doesNotMatch(timeline, /height: 6, backgroundColor/);
});
