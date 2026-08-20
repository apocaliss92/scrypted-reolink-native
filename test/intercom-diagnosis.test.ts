import { describe, expect, it } from "vitest";
import { describeStartupFailure } from "../src/intercom";

/**
 * Field logs contain two talkback failures that the old message — "no PCM data
 * received" — could not tell apart, and whose causes point in opposite
 * directions:
 *
 *  - the relay works and the client is silent (a microphone problem);
 *  - ffmpeg never got through the RTSP handshake, so the client's microphone
 *    was never reached at all (not a microphone problem).
 *
 * The discriminator is the `Input #` banner: dump_format() emits it once
 * avformat_open_input has completed OPTIONS/DESCRIBE/SETUP/PLAY, and it needs
 * no RTP to appear. In one reporter's capture ffmpeg printed nothing at all for
 * the whole 10s window, which is the second shape — and stderr is never fully
 * buffered in C, so that silence is real rather than output lost on SIGKILL.
 */

describe("describeStartupFailure", () => {
  it("blames the client when the RTSP input did open", () => {
    const msg = describeStartupFailure({
      inputOpenedAtMs: 120,
      stderrBytes: 400,
    });

    expect(msg).toMatch(/not sending microphone audio/);
    expect(msg).toContain("120ms");
    // Must not send the reader after the relay, which demonstrably worked.
    expect(msg).not.toMatch(/handshake .* never completed/);
  });

  it("blames the handshake when ffmpeg printed nothing at all", () => {
    const msg = describeStartupFailure({ stderrBytes: 0 });

    expect(msg).toMatch(/handshake/);
    // The actionable part: stop the reporter chasing microphone permissions.
    expect(msg).toMatch(/not a microphone problem/);
  });

  it("distinguishes 'printed something but never opened' from total silence", () => {
    const noisy = describeStartupFailure({ stderrBytes: 512 });
    const silent = describeStartupFailure({ stderrBytes: 0 });

    expect(noisy).not.toBe(silent);
    expect(noisy).toContain("512 bytes of stderr");
    expect(noisy).toMatch(/never opened the RTSP input/);
  });

  it("treats an input opened at 0ms as opened, not as missing", () => {
    // Guard against a truthiness check creeping back in: 0 is a valid elapsed
    // time and would flip the diagnosis to the opposite cause.
    const msg = describeStartupFailure({ inputOpenedAtMs: 0, stderrBytes: 0 });
    expect(msg).toMatch(/not sending microphone audio/);
  });

  it("prefers the input signal over the stderr count", () => {
    // Both signals present: having opened the input is the stronger fact.
    expect(
      describeStartupFailure({ inputOpenedAtMs: 50, stderrBytes: 0 }),
    ).toMatch(/not sending microphone audio/);
  });
});
