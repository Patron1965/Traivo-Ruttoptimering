import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeThemeVariables,
  getContrastRatio,
  normalizeHex,
  THEME_CSS_VARS,
  hslToRgb,
  rgbToHex,
  hexToHslStr,
} from "./theme-utils.ts";

describe("Theme Utils", () => {
  it("makes dark brand text and button labels readable without changing light branding", () => {
    const toHex = (value: string) => {
      const [h, s, l] = value.split(" ").map(parseFloat);
      return rgbToHex(...hslToRgb(h / 360, s / 100, l / 100));
    };
    for (const primaryColor of ["#554bb1", "#312e81", "#166534", "#991b1b"]) {
      const brand = { primaryColor, backgroundColor: "#262626" };
      const dark = computeThemeVariables(brand, "dark");
      for (const surface of ["--background", "--muted", "--sidebar-accent"]) {
        assert.ok(getContrastRatio(toHex(dark["--primary"]), toHex(dark[surface])) >= 4.5, `${primaryColor} against ${surface}`);
      }
      assert.ok(getContrastRatio(toHex(dark["--primary"]), toHex(dark["--primary-foreground"])) >= 4.5);
      assert.equal(computeThemeVariables(brand, "light")["--primary"], hexToHslStr(primaryColor));
    }
  });
  describe("hex normalization", () => {
    it("handles 3 digit hex", () => {
      assert.equal(normalizeHex("#fff"), "#ffffff");
      assert.equal(normalizeHex("abc"), "#aabbcc");
    });

    it("handles 6 digit hex", () => {
      assert.equal(normalizeHex("#123456"), "#123456");
      assert.equal(normalizeHex("123456"), "#123456");
    });

    it("handles 8 digit hex (strips alpha)", () => {
      assert.equal(normalizeHex("#12345678"), "#123456");
    });
  });

  describe("contrast ratio", () => {
    it("computes accessible foregrounds", () => {
      const varsDarkBg = computeThemeVariables({ backgroundColor: "#0f172a" });
      const varsLightBg = computeThemeVariables({ backgroundColor: "#ffffff" });

      assert.ok(varsDarkBg["--foreground"]);
      assert.ok(varsLightBg["--foreground"]);

      // Should result in readable contrast
      const darkRatio = getContrastRatio("#0f172a", "#ffffff"); // vs white (typically > 4.5)
      assert.ok(darkRatio > 4.5);
    });
  });

  describe("theme variable generation", () => {
    it("generates variables for primary color", () => {
      const vars = computeThemeVariables({ primaryColor: "#3b82f6" });
      assert.ok(vars["--primary"]);
      assert.ok(vars["--primary-foreground"]);
      assert.ok(vars["--ring"]);
      assert.ok(vars["--sidebar-primary"]);
    });

    it("generates variables for background color", () => {
      const vars = computeThemeVariables({ backgroundColor: "#1e293b" });
      assert.ok(vars["--background"]);
      assert.ok(vars["--foreground"]);
      assert.ok(vars["--card"]);
      assert.ok(vars["--muted"]);
      assert.ok(vars["--border"]);
      assert.ok(vars["--sidebar"]);
    });

    it("returns empty object for empty brand", () => {
      const vars = computeThemeVariables({});
      assert.equal(Object.keys(vars).length, 0);
    });

    it("generates all requested standard CSS variables when full brand provided", () => {
      const vars = computeThemeVariables({
        primaryColor: "#ef4444",
        accentColor: "#10b981",
        backgroundColor: "#f8fafc",
      });

      // All THEME_CSS_VARS should be present
      for (const v of THEME_CSS_VARS) {
        assert.ok(vars[v], `expected ${v} to be generated`);
      }
    });
  });
});
