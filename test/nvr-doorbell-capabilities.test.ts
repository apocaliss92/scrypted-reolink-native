import { describe, expect, it } from "vitest";
import { ScryptedDeviceType, ScryptedInterface } from "@scrypted/sdk";
import type { DeviceCapabilities } from "@apocaliss92/nodelink-js" with { "resolution-mode": "import" };
import { normalizeDoorbellCapabilities } from "../src/capabilities";
import { getDeviceInterfaces } from "../src/utils";

// Relevant fields from the reported NVR response. The doorbell advertises
// doorbellVersion=0, while its channelType explicitly identifies it.
function response(channel = 3, isDoorbell = false) {
  return {
    capabilities: { channel, isDoorbell } as DeviceCapabilities,
    support: {
      items: [
        { chnID: 4, channelType: "ipc", doorbellVersion: 0 },
        { chnID: 3, channelType: "Doorbell", doorbellVersion: 0 },
      ],
    },
    objects: ["people"],
    presets: [],
  };
}

describe("NVR doorbell capabilities", () => {
  it("recognizes the reported channel and supplies both doorbell interfaces", () => {
    const raw = response();
    const normalized = normalizeDoorbellCapabilities(raw);
    expect(normalized.capabilities.isDoorbell).toBe(true);
    expect(raw.capabilities.isDoorbell).toBe(false);
    expect(normalized.support).toBe(raw.support);
    const { type, interfaces } = getDeviceInterfaces({
      capabilities: normalized.capabilities,
      logger: console,
    });
    expect(type).toBe(ScryptedDeviceType.Doorbell);
    expect(interfaces).toContain(ScryptedInterface.BinarySensor);
  });

  it("does not classify other NVR channels as doorbells", () => {
    for (const channel of [0, 4]) {
      const raw = response(channel);
      expect(normalizeDoorbellCapabilities(raw)).toBe(raw);
      expect(raw.capabilities.isDoorbell).toBe(false);
    }
  });

  it("preserves existing positive detection without Support data", () => {
    const raw = { capabilities: response(0, true).capabilities };
    expect(normalizeDoorbellCapabilities(raw)).toBe(raw);
  });

  it("leaves missing Support information unchanged", () => {
    for (const support of [undefined, {}, { items: [] }]) {
      const raw = { capabilities: response().capabilities, support };
      expect(normalizeDoorbellCapabilities(raw)).toBe(raw);
    }
  });

  it("accepts case and surrounding whitespace in channelType", () => {
    const raw = response();
    raw.support.items[1].channelType = " doorBELL ";
    expect(normalizeDoorbellCapabilities(raw).capabilities.isDoorbell).toBe(true);
  });
});
