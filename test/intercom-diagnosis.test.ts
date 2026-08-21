import { describe, expect, it } from "vitest";
import { describeStartupFailure } from "../src/intercom";

/**
 * A talkback session that produces no audio has three distinguishable causes,
 * with three different owners. Reported logs contained the middle one, and the
 * original single message ("no PCM data received") pointed at none of them.
 *
 * The signals come from ffmpeg's verbose output: "Successfully connected" for
 * the socket, and the `Input #` banner, which dump_format() emits once
 * avformat_open_input has finished OPTIONS/DESCRIBE/SETUP/PLAY and which needs
 * no RTP to appear.
 *
 * Reproduced directly against a server that accepts a connection and never
 * replies: ffmpeg waits indefinitely and, at the default log level, prints zero
 * bytes for the whole window — matching the field capture byte for byte, and
 * the reason `-loglevel verbose` is now passed.
 */

describe("describeStartupFailure", () => {
  it("blames the client when the RTSP input did open", () => {
    const msg = describeStartupFailure({
      inputOpenedAtMs: 120,
      tcpConnectedAtMs: 5,
      stderrBytes: 400,
    });

    expect(msg).toMatch(/not sending microphone audio/);
    expect(msg).toContain("120ms");
  });

  it("blames the relay when the socket connected but the input never opened", () => {
    // The shape two reporters produced.
    const msg = describeStartupFailure({
      tcpConnectedAtMs: 7,
      stderrBytes: 139,
    });

    expect(msg).toMatch(/never answered the RTSP handshake/);
    expect(msg).toContain("7ms");
    // Must send the reader to the relay, not back to the microphone.
    expect(msg).not.toMatch(/microphone audio/);
  });

  it("blames reachability when ffmpeg never connected at all", () => {
    const msg = describeStartupFailure({ stderrBytes: 220 });

    expect(msg).toMatch(/never reached Scrypted's local relay/);
    expect(msg).toContain("220 bytes");
  });

  it("flags total silence as impossible now that verbose is on", () => {
    // With -loglevel verbose the connection attempt always prints, so reaching
    // this branch means ffmpeg is not running the arguments we logged.
    const msg = describeStartupFailure({ stderrBytes: 0 });
    expect(msg).toMatch(/not running the arguments logged above/);
  });

  it("orders the signals: input beats socket beats stderr", () => {
    expect(
      describeStartupFailure({
        inputOpenedAtMs: 50,
        tcpConnectedAtMs: 10,
        stderrBytes: 900,
      }),
    ).toMatch(/not sending microphone audio/);

    expect(
      describeStartupFailure({ tcpConnectedAtMs: 10, stderrBytes: 900 }),
    ).toMatch(/never answered the RTSP handshake/);
  });

  it("treats 0ms as a real measurement, not a missing one", () => {
    // A truthiness check on either field would invert the diagnosis.
    expect(
      describeStartupFailure({ inputOpenedAtMs: 0, stderrBytes: 0 }),
    ).toMatch(/not sending microphone audio/);

    expect(
      describeStartupFailure({ tcpConnectedAtMs: 0, stderrBytes: 0 }),
    ).toMatch(/never answered the RTSP handshake/);
  });
});
