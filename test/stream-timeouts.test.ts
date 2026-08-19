import { describe, expect, it } from "vitest";
import { StreamManager, type StreamManagerOptions } from "../src/stream-utils";

/**
 * Issue #20 — intermittent "Camera Not Responding" in HomeKit for battery/solar
 * cameras behind a Reolink Hub.
 *
 * The longer keyframe wait was applied only to composite/panorama streams, on
 * the grounds that they "can take a bit longer to start". The same is true of a
 * camera that has to wake from sleep first, but those channels kept the 5s
 * library default, so a slow wake-up read as a dead stream.
 */

// `resolveStreamTimeouts` is private, and the surrounding method needs a live
// camera. Drive it through the prototype with just the options it reads.
function resolve(
  opts: Partial<StreamManagerOptions>,
  isComposite: boolean,
): { keyframeTimeoutMs?: number; idleTeardownMs?: number } {
  const fn = (StreamManager.prototype as any).resolveStreamTimeouts;
  return fn.call({ opts }, isComposite);
}

describe("keyframe timeout selection (issue #20)", () => {
  it("gives battery cameras the same long wait as composite streams", () => {
    expect(resolve({ batteryCamera: true }, false)).toEqual({
      keyframeTimeoutMs: 20_000,
      idleTeardownMs: 20_000,
    });
  });

  it("still gives composite streams the long wait", () => {
    expect(resolve({}, true)).toEqual({
      keyframeTimeoutMs: 20_000,
      idleTeardownMs: 20_000,
    });
  });

  it("leaves the library default in place for plain wired cameras", () => {
    // Returning nothing is deliberate: it keeps the library free to change its
    // own default without this plugin pinning a stale copy of it.
    expect(resolve({}, false)).toEqual({});
  });

  it("does not treat an NVR channel as a battery camera", () => {
    // `sharedConnection` is true for both battery cameras and NVR/Hub channels,
    // which is why the battery case needs its own flag.
    expect(resolve({ sharedConnection: true }, false)).toEqual({});
  });

  it("lets an explicit setting override the automatic value", () => {
    expect(resolve({ keyframeTimeoutMs: 45_000, batteryCamera: true }, false)).toEqual({
      keyframeTimeoutMs: 45_000,
      idleTeardownMs: 45_000,
    });
    expect(resolve({ keyframeTimeoutMs: 8_000 }, true)).toEqual({
      keyframeTimeoutMs: 8_000,
      idleTeardownMs: 8_000,
    });
  });

  it("ignores an unusable configured value rather than pinning a bad timeout", () => {
    for (const bad of [0, -1, Number.NaN, undefined]) {
      expect(resolve({ keyframeTimeoutMs: bad as number }, false)).toEqual({});
    }
  });
});
