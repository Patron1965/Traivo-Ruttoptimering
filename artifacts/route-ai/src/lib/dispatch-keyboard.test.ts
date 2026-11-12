import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createDispatchKeyboardHandler,
  type DispatchKeyboardContext,
} from "./dispatch-keyboard.ts";

function fixture(overrides: Partial<DispatchKeyboardContext> = {}) {
  const calls: Array<[string, unknown?]> = [];
  const record = (name: string) => (value: unknown) => { calls.push([name, value]); };
  const context: DispatchKeyboardContext = {
    kbdHelpOpen: false,
    focusMode: false,
    overviewOpen: false,
    selectedStopId: null,
    inboxRailOpen: false,
    actionQueueOpen: false,
    scheduledRows: [{ routeId: "unplanned" }, { routeId: "route-a" }, { routeId: "route-b" }],
    flatStopList: [{ stopId: "stop-a", rowIdx: 0 }, { stopId: "stop-b", rowIdx: 2 }],
    searchInputRef: { current: { focus: () => { calls.push(["search"]); } } },
    dispatchAllRef: { current: () => { calls.push(["dispatch"]); } },
    setKbdHelpOpen: record("help"),
    setFocusMode: record("focus"),
    setOverviewOpen: record("overview"),
    setSelectedStopId: record("stop"),
    setInboxRailOpen: record("inbox"),
    setActionQueueOpen: record("queue"),
    setSelectedStopIds: record("selection"),
    setHighlightedRouteId: record("route"),
    setSelectedRowIdx: record("row"),
    setFocusStopId: record("focusStop"),
    ...overrides,
  };
  return { context, calls, handle: createDispatchKeyboardHandler(context) };
}

function keyEvent(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    target: null,
    defaultPrevented: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault() { this.defaultPrevented = true; },
    ...overrides,
  } as unknown as KeyboardEvent;
}

test("both Dispatch views bind the complete shared shortcut context and clean up their listener", () => {
  const source = readFileSync(new URL("../pages/Dispatch.tsx", import.meta.url), "utf8");
  const views = source.split("function DispatchIncoming()");
  assert.equal(views.length, 2);
  const expectedKeys = Object.keys(fixture().context).sort();
  for (const view of views) {
    const bindings = [...view.matchAll(/const onKey = createDispatchKeyboardHandler\(\{([\s\S]*?)\}\);/g)];
    assert.equal(bindings.length, 1);
    assert.deepEqual(bindings[0][1].split(",").map((key) => key.trim()).filter(Boolean).sort(), expectedKeys);
    assert.match(view, /window\.addEventListener\("keydown", onKey\)/);
    assert.match(view, /return \(\) => window\.removeEventListener\("keydown", onKey\)/);
    assert.doesNotMatch(view, /if \(e\.key === "Escape"\)/);
  }
});

const layers: Partial<DispatchKeyboardContext> = {
  kbdHelpOpen: true, focusMode: true, overviewOpen: true, selectedStopId: "stop-a",
  inboxRailOpen: true, actionQueueOpen: true,
};

for (const [name, disabled, expected] of [
  ["help", {}, [["help", false]]],
  ["focus mode", { kbdHelpOpen: false }, [["focus", false]]],
  ["overview", { kbdHelpOpen: false, focusMode: false }, [["overview", false]]],
  ["stop details", { kbdHelpOpen: false, focusMode: false, overviewOpen: false }, [["stop", null]]],
  ["side panels", { kbdHelpOpen: false, focusMode: false, overviewOpen: false, selectedStopId: null },
    [["inbox", false], ["queue", false]]],
] as const) {
  test(`Escape closes only ${name} ahead of lower-priority state`, () => {
    const { handle, calls } = fixture({ ...layers, ...disabled });
    const event = keyEvent("Escape");
    handle(event);
    assert.deepEqual(calls, expected);
    assert.equal(event.defaultPrevented, false);
  });
}

test("Escape closes either side panel before clearing selection", () => {
  for (const panels of [{ inboxRailOpen: true }, { actionQueueOpen: true }]) {
    const { handle, calls } = fixture(panels);
    handle(keyEvent("Escape"));
    assert.deepEqual(calls, [["inbox", false], ["queue", false]]);
  }
});

test("Escape clears stop and route selection only after all higher-priority layers are closed", () => {
  const { handle, calls } = fixture();
  handle(keyEvent("Escape"));
  assert.deepEqual(calls, [["selection", new Set()], ["route", null]]);
});

test("already handled events never trigger any global shortcut, including Escape", () => {
  for (const key of ["Escape", "f", "F", "/", "?", "Enter", "1", "j", "k"]) {
    const { handle, calls } = fixture(layers);
    handle(keyEvent(key, { defaultPrevented: true, ctrlKey: true }));
    assert.deepEqual(calls, [], key);
  }
});

test("editable controls suppress shortcuts but preserve Escape priority", () => {
  for (const target of [
    { tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true },
  ]) {
    const { handle, calls } = fixture(layers);
    for (const key of ["f", "F", "/", "?", "Enter", "1", "j", "k"]) {
      const event = keyEvent(key, { target, ctrlKey: true });
      handle(event);
      assert.equal(event.defaultPrevented, false);
    }
    assert.deepEqual(calls, []);
    handle(keyEvent("Escape", { target }));
    assert.deepEqual(calls, [["help", false]]);
  }
});

test("focus and help shortcuts toggle their current value", () => {
  for (const [key, name] of [["f", "focus"], ["F", "focus"], ["?", "help"]]) {
    const { handle, calls } = fixture();
    const event = keyEvent(key);
    handle(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], name);
    const toggle = calls[0][1] as (value: boolean) => boolean;
    assert.equal(toggle(false), true);
    assert.equal(toggle(true), false);
  }
});

test("slash focuses search and tolerates an unmounted search input", () => {
  const { handle, calls } = fixture();
  const event = keyEvent("/");
  handle(event);
  assert.deepEqual(calls, [["search"]]);
  assert.equal(event.defaultPrevented, true);
  assert.doesNotThrow(() => fixture({ searchInputRef: { current: null } }).handle(keyEvent("/")));
});

test("Ctrl/Meta Enter uses the current dispatch callback; plain Enter does nothing", () => {
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    const { context, handle, calls } = fixture();
    const event = keyEvent("Enter", modifier);
    context.dispatchAllRef.current = () => { calls.push(["current dispatch"]); };
    handle(event);
    assert.deepEqual(calls, [["current dispatch"]]);
    assert.equal(event.defaultPrevented, true);
  }
  const { handle, calls } = fixture();
  handle(keyEvent("Enter"));
  assert.deepEqual(calls, []);
  assert.doesNotThrow(() => fixture({ dispatchAllRef: { current: null } }).handle(keyEvent("Enter", { ctrlKey: true })));
});

test("1–9 highlight planned routes only and do not consume the event", () => {
  const { handle, calls } = fixture();
  for (const [key, route] of [["1", "route-a"], ["2", "route-b"]]) {
    const event = keyEvent(key);
    handle(event);
    assert.deepEqual(calls.pop(), ["route", route]);
    assert.equal(event.defaultPrevented, false);
  }
  for (const key of ["0", "3", "9", "10"]) handle(keyEvent(key));
  assert.deepEqual(calls, []);
});

test("j/k navigate stops, update row and map focus, and clamp at the ends", () => {
  for (const [key, selectedStopId, nextStop, nextRow] of [
    ["j", null, "stop-a", 0], ["k", null, "stop-a", 0],
    ["j", "missing", "stop-a", 0], ["k", "missing", "stop-a", 0],
    ["j", "stop-a", "stop-b", 2], ["k", "stop-b", "stop-a", 0],
    ["j", "stop-b", "stop-b", 2], ["k", "stop-a", "stop-a", 0],
  ] as const) {
    const { handle, calls } = fixture({ selectedStopId });
    const event = keyEvent(key);
    handle(event);
    assert.deepEqual(calls, [["stop", nextStop], ["row", nextRow], ["focusStop", nextStop]]);
    assert.equal(event.defaultPrevented, true);
  }
});

test("empty stop lists and unrelated keys leave state unchanged", () => {
  const { handle, calls } = fixture({ flatStopList: [] });
  for (const key of ["j", "k", "J", "K", "x"]) handle(keyEvent(key));
  assert.deepEqual(calls, []);
});
