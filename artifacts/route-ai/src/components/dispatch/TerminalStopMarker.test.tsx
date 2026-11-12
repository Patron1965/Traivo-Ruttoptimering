import * as React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalStopMarker } from "./TerminalStopMarker";

test("skipped stops retain an accessible label without an arrow", () => {
  const html = renderToStaticMarkup(<TerminalStopMarker stop={{ status: "skipped", terminalAt: "2026-11-09T09:42:00Z" }} />);
  assert.match(html, /stop-skipped-marker/);
  assert.match(html, /aria-label="Hoppat över av chauffören 10:42 · faktisk tid"/);
  assert.match(html, /sr-only/);
  assert.doesNotMatch(html, /<svg/);
  assert.doesNotMatch(html, /stop-completion-marker/);
});
test("completed and pending stops retain their different meaning", () => {
  assert.match(renderToStaticMarkup(<TerminalStopMarker stop={{ status: "completed" }} />), /stop-completion-marker/);
  assert.equal(renderToStaticMarkup(<TerminalStopMarker stop={{ status: "pending" }} />), "");
  assert.equal(renderToStaticMarkup(<TerminalStopMarker stop={{ status: "failed" }} />), "");
  assert.match(renderToStaticMarkup(<TerminalStopMarker stop={{ status: "skipped", terminalAt: "invalid" }} />), /faktisk tid saknas/);
});
