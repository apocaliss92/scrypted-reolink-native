import { describe, expect, it } from "vitest";
import { ScryptedDeviceType, ScryptedInterface } from "@scrypted/sdk";
import { getDeviceInterfaces } from "../src/utils";

/**
 * Two-way audio on a battery doorbell did nothing: pressing the mic in the
 * Scrypted NVR web UI produced no log line from WebRTC or from this plugin.
 *
 * Intercom was only supplied by the "Reolink Native Intercom" mixin, which was
 * auto-enabled by appending it — after WebRTC. The WebRTC mixin only sees the
 * interfaces contributed before it, so it negotiated `recvonly`, the browser
 * never attached the microphone, and startIntercom was never reached.
 *
 * The fix is to declare Intercom on the device whenever the camera reports it,
 * so it is in the base every mixin starts from. These tests pin the gate: it is
 * on for talk-capable cameras and off for everything else.
 */

const logger = console;

function caps(over: Partial<Record<string, unknown>> = {}): any {
  return {
    channel: 0,
    ptzMode: "none",
    hasPan: false,
    hasTilt: false,
    hasZoom: false,
    hasPresets: false,
    hasPtz: false,
    hasBattery: false,
    hasIntercom: false,
    hasSiren: false,
    hasFloodlight: false,
    hasPir: false,
    hasAutotracking: false,
    isDoorbell: false,
    hasWirelessChime: false,
    hasPowerSourceSwitch: false,
    ...over,
  };
}

const interfacesFor = (over: Partial<Record<string, unknown>>, isLensDevice = false) =>
  getDeviceInterfaces({ capabilities: caps(over), logger, isLensDevice })
    .interfaces;

describe("intercom interface gating", () => {
  it("advertises Intercom on the device when the camera reports hasIntercom", () => {
    expect(interfacesFor({ hasIntercom: true })).toContain(
      ScryptedInterface.Intercom,
    );
  });

  it("does not advertise it on cameras without two-way audio", () => {
    expect(interfacesFor({ hasIntercom: false })).not.toContain(
      ScryptedInterface.Intercom,
    );
    expect(interfacesFor({ hasIntercom: undefined })).not.toContain(
      ScryptedInterface.Intercom,
    );
  });

  it("covers the battery doorbell from the report", () => {
    const { interfaces, type } = getDeviceInterfaces({
      capabilities: caps({
        hasIntercom: true,
        isDoorbell: true,
        hasBattery: true,
      }),
      logger,
    });
    expect(type).toBe(ScryptedDeviceType.Doorbell);
    expect(interfaces).toContain(ScryptedInterface.Intercom);
    expect(interfaces).toContain(ScryptedInterface.BinarySensor);
    expect(interfaces).toContain(ScryptedInterface.Battery);
  });

  it("leaves the interface list of a non-talk camera exactly as before", () => {
    const without = interfacesFor({ hasPtz: true, hasSiren: true });
    const withTalk = interfacesFor({
      hasPtz: true,
      hasSiren: true,
      hasIntercom: true,
    });
    expect(withTalk.filter((i) => i !== ScryptedInterface.Intercom)).toEqual(
      without,
    );
  });

  it("applies to multifocal lens devices too", () => {
    expect(interfacesFor({ hasIntercom: true }, true)).toContain(
      ScryptedInterface.Intercom,
    );
  });

  it("emits no duplicates", () => {
    const interfaces = interfacesFor({ hasIntercom: true, isDoorbell: true });
    expect(new Set(interfaces).size).toBe(interfaces.length);
  });
});
