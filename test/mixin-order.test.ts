import { describe, expect, it } from "vitest";
import { isMixinFirst, withMixinFirst } from "../src/mixin-order";

/**
 * Reported as: the iPhone/iPad microphone is never used. Permission is granted,
 * but iOS never shows the orange recording indicator — in the Scrypted app and
 * in Home Assistant alike.
 *
 * That indicator is client side, so nothing had reached the plugin to log: the
 * SDP was already wrong. Scrypted composes mixins in array order and gives each
 * one only the interfaces contributed before it, and the WebRTC mixin decides
 * the audio transceiver direction from that list — `sendrecv` with `Intercom`,
 * `recvonly` without. The intercom mixin was appended, landing after WebRTC, so
 * the client was never asked for a microphone.
 */

const INTERCOM = "reolink-native-intercom";
const WEBRTC = "webrtc-mixin";
const REBROADCAST = "rebroadcast-mixin";

describe("withMixinFirst", () => {
  it("puts the intercom mixin ahead of an already-installed WebRTC mixin", () => {
    // The regression, exactly: appended after WebRTC.
    expect(withMixinFirst([WEBRTC, INTERCOM], INTERCOM)).toEqual([
      INTERCOM,
      WEBRTC,
    ]);
  });

  it("adds it to the front when not installed at all", () => {
    expect(withMixinFirst([WEBRTC], INTERCOM)).toEqual([INTERCOM, WEBRTC]);
  });

  it("preserves the relative order of the other mixins", () => {
    // Reordering someone's chain beyond what is required would be its own bug.
    expect(
      withMixinFirst([REBROADCAST, WEBRTC, INTERCOM], INTERCOM),
    ).toEqual([INTERCOM, REBROADCAST, WEBRTC]);
  });

  it("does not duplicate an entry that is already first", () => {
    expect(withMixinFirst([INTERCOM, WEBRTC], INTERCOM)).toEqual([
      INTERCOM,
      WEBRTC,
    ]);
  });

  it("removes duplicates rather than leaving a stale copy behind", () => {
    expect(
      withMixinFirst([WEBRTC, INTERCOM, REBROADCAST, INTERCOM], INTERCOM),
    ).toEqual([INTERCOM, WEBRTC, REBROADCAST]);
  });

  it("handles a device with no mixins yet", () => {
    expect(withMixinFirst(undefined, INTERCOM)).toEqual([INTERCOM]);
    expect(withMixinFirst([], INTERCOM)).toEqual([INTERCOM]);
  });
});

describe("isMixinFirst", () => {
  it("is true only when nothing needs correcting", () => {
    expect(isMixinFirst([INTERCOM, WEBRTC], INTERCOM)).toBe(true);
    expect(isMixinFirst([WEBRTC, INTERCOM], INTERCOM)).toBe(false);
    expect(isMixinFirst([WEBRTC], INTERCOM)).toBe(false);
    expect(isMixinFirst(undefined, INTERCOM)).toBe(false);
  });

  it("agrees with withMixinFirst being a no-op", () => {
    for (const chain of [
      [INTERCOM, WEBRTC],
      [WEBRTC, INTERCOM],
      [REBROADCAST, WEBRTC],
      [],
    ]) {
      const already = isMixinFirst(chain, INTERCOM);
      const rewritten = withMixinFirst(chain, INTERCOM);
      expect(already).toBe(
        JSON.stringify(rewritten) === JSON.stringify(chain),
      );
    }
  });
});
