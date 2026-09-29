import { describe, expect, it } from "vitest";
import { isAdapterPowered } from "../src/battery-power";

/**
 * Reolink Video Doorbell (firmware v3.0.0.7261_26092204) reports
 * adapterStatus "ACAdapter" while it is on its mains adapter. The plugin only
 * matched "adapter" | "solarPanel", so the doorbell was published as NotCharging
 * and Scrypted's Rebroadcast plugin refused to prebuffer it (battery cameras
 * prebuffer only while charging).
 */
describe("adapter power detection", () => {
  it("treats a mains adapter and a solar panel as charging", () => {
    expect(isAdapterPowered("adapter")).toBe(true);
    expect(isAdapterPowered("solarPanel")).toBe(true);
  });

  it("recognises the ACAdapter value reported by the Video Doorbell", () => {
    expect(isAdapterPowered("ACAdapter")).toBe(true);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(isAdapterPowered("ADAPTER")).toBe(true);
    expect(isAdapterPowered(" acadapter ")).toBe(true);
    expect(isAdapterPowered("SolarPanel")).toBe(true);
  });

  it("treats battery, missing and unrecognised values as not adapter powered", () => {
    for (const v of ["none", "battery", "", "   ", "charging", "somethingNew", undefined, null]) {
      expect(isAdapterPowered(v as string | null | undefined)).toBe(false);
    }
  });
});
