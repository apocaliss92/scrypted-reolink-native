import { describe, expect, it } from "vitest";
import { shouldAcceptSleepPushSource } from "@apocaliss92/nodelink-js";
import { resolveBatterySleepPushMethod } from "../src/utils";

describe("resolveBatterySleepPushMethod", () => {
  it("defaults auto to webhook when HaCfg is supported", () => {
    expect(resolveBatterySleepPushMethod("auto", true)).toBe("webhook");
    expect(resolveBatterySleepPushMethod(undefined, true)).toBe("webhook");
  });

  it("defaults auto to email when HaCfg is unsupported", () => {
    expect(resolveBatterySleepPushMethod("auto", false)).toBe("email");
    expect(resolveBatterySleepPushMethod(undefined, false)).toBe("email");
  });

  it("honours explicit webhook / email preferences", () => {
    expect(resolveBatterySleepPushMethod("webhook", false)).toBe("webhook");
    expect(resolveBatterySleepPushMethod("email", true)).toBe("email");
  });
});

describe("shouldAcceptSleepPushSource (lib)", () => {
  it("never filters native baichuan", () => {
    expect(shouldAcceptSleepPushSource("baichuan", "email", true)).toBe(true);
  });

  it("auto with HaCfg support accepts webhook and drops email", () => {
    expect(shouldAcceptSleepPushSource("baichuanWebhook", "auto", true)).toBe(
      true,
    );
    expect(shouldAcceptSleepPushSource("email", "auto", true)).toBe(false);
  });
});
