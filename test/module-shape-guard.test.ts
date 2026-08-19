import { describe, expect, it } from "vitest";
import { assertConstructible } from "../src/connect";

/**
 * Issue #22 — "pu is not a constructor", reported against 0.5.55.
 *
 * `pu` is the name the minifier gives `ReolinkBaichuanApi` in the plugin
 * bundle, so the symbol had resolved to something non-constructible at the
 * `new` site. That has not been reproduced against any published build, and the
 * construction site in question lives in the library's autodetect rather than
 * here — so this is a diagnostic, not a fix: it makes the plugin's own paths
 * name the export that went missing and what arrived instead.
 */

describe("assertConstructible (issue #22)", () => {
  it("passes constructors straight through", () => {
    class Api {}
    expect(assertConstructible(Api, "Api", "lib")).toBe(Api);
  });

  it("names the export and the module when the symbol is undefined", () => {
    expect(() =>
      assertConstructible(undefined, "ReolinkBaichuanApi", "@apocaliss92/nodelink-js"),
    ).toThrow(/ReolinkBaichuanApi.*@apocaliss92\/nodelink-js|@apocaliss92\/nodelink-js.*ReolinkBaichuanApi/);
  });

  it("reports what actually arrived instead of a minified name", () => {
    // The interop shape most likely to produce this: the namespace object
    // rather than the class itself.
    expect(() =>
      assertConstructible({ default: class {} }, "ReolinkBaichuanApi", "lib"),
    ).toThrow(/keys \[default\]/);

    expect(() => assertConstructible(undefined, "X", "lib")).toThrow(/got undefined/);
    expect(() => assertConstructible(null, "X", "lib")).toThrow(/got null/);
    expect(() => assertConstructible(42, "X", "lib")).toThrow(/got number \(42\)/);
  });

  it("asks for the version detail the report was missing", () => {
    expect(() => assertConstructible(undefined, "X", "lib")).toThrow(
      /Scrypted and Node versions/,
    );
  });
});
