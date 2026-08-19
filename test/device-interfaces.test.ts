import { describe, expect, it, vi } from "vitest";
import { ScryptedInterface } from "@scrypted/sdk";
import { getDeviceInterfaces } from "../src/utils";

/**
 * Reported as: the iPhone/iPad microphone is never used. The talk buttons are
 * present, permission is granted, but iOS never shows the orange recording
 * indicator — in the Scrypted app and in Home Assistant alike.
 *
 * The buttons come from the device's advertised interface union, which is why
 * they showed up. The microphone does not: the WebRTC mixin reads
 * `mixinDeviceInterfaces`, which holds only the interfaces accumulated *before*
 * it in the mixin chain, and chooses `sendrecv` or `recvonly` from whether
 * `Intercom` is in there. With `recvonly` the peer connection refuses a client
 * microphone track, so the client is never asked for one and `startIntercom` is
 * never reached — nothing to log, anywhere.
 *
 * Supplying `Intercom` from a mixin made this depend on chain order. Provided by
 * the device it is the base every mixin starts from. This is also how the
 * official @scrypted/reolink plugin does it.
 */

const logger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
} as unknown as Console;

function interfacesFor(capabilities: Record<string, unknown>): string[] {
  return getDeviceInterfaces({ capabilities: capabilities as never, logger })
    .interfaces;
}

describe("device interfaces: intercom (iOS microphone)", () => {
  it("advertises Intercom on the device when the camera supports it", () => {
    expect(interfacesFor({ hasIntercom: true })).toContain(
      ScryptedInterface.Intercom,
    );
  });

  it("does not advertise it on cameras without two-way audio", () => {
    expect(interfacesFor({ hasIntercom: false })).not.toContain(
      ScryptedInterface.Intercom,
    );
    expect(interfacesFor({})).not.toContain(ScryptedInterface.Intercom);
  });

  it("advertises it on doorbells, which is where talkback matters most", () => {
    const { interfaces, type } = getDeviceInterfaces({
      capabilities: { hasIntercom: true, isDoorbell: true } as never,
      logger,
    });
    expect(interfaces).toContain(ScryptedInterface.Intercom);
    expect(type).toBe("Doorbell");
  });

  it("keeps advertising it for lens sub-devices of a multifocal camera", () => {
    const interfaces = getDeviceInterfaces({
      capabilities: { hasIntercom: true } as never,
      logger,
      isLensDevice: true,
    }).interfaces;
    expect(interfaces).toContain(ScryptedInterface.Intercom);
  });

  it("does not disturb the other capability-driven interfaces", () => {
    const interfaces = interfacesFor({ hasIntercom: true, hasPtz: true });
    expect(interfaces).toContain(ScryptedInterface.PanTiltZoom);
    expect(interfaces).toContain(ScryptedInterface.VideoCamera);
    // No duplicates — Scrypted sorts and dedupes, but emitting clean input
    // keeps the manifest readable.
    expect(new Set(interfaces).size).toBe(interfaces.length);
  });
});
