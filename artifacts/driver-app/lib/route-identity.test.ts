import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeIdentityLine } from "./route-identity.ts";
import { computeBottomChromeHeight } from "../hooks/bottom-chrome.ts";

describe("routeIdentityLine", () => {
  it("drops resource name already in route title, keeps full title and plate", () => {
    const title = "TOMAS \u2013 Tomas test driver \u2013 2026-11-04 01:00";
    assert.equal(routeIdentityLine(title, "Tomas test driver", "ABC 123", "Tomas test driver"), `${title} \u2022 ABC 123`);
  });
  it("keeps distinct vehicle name", () => {
    assert.equal(routeIdentityLine("Rutt Nord", "Volvo FH", "XYZ 9", "Anna"), "Rutt Nord \u2022 Volvo FH \u2022 XYZ 9");
  });
  it("drops vehicle equal to driver name without route", () => {
    assert.equal(routeIdentityLine(null, "Anna Berg", "ABC 1", "anna berg"), "ABC 1");
  });
});

describe("computeBottomChromeHeight", () => {
  it("expanded is only row + inset (toggle sits inside the row)", () => {
    assert.equal(computeBottomChromeHeight({ expanded: true, collapsible: true, insetBottom: 34, rowHeight: 56 }), 90);
  });
  it("expanded native row without inset", () => {
    assert.equal(computeBottomChromeHeight({ expanded: true, collapsible: true, insetBottom: 0, rowHeight: 50 }), 50);
  });
  it("collapsed only toggle + inset", () => {
    assert.equal(computeBottomChromeHeight({ expanded: false, collapsible: true, insetBottom: 34, rowHeight: 56 }), 84);
  });
  it("non-collapsible (NativeTabs) ignores toggle", () => {
    assert.equal(computeBottomChromeHeight({ expanded: false, collapsible: false, insetBottom: 0, rowHeight: 50 }), 50);
  });
});
