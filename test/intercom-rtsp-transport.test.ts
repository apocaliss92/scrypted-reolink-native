import { describe, expect, it } from "vitest";
import { ReolinkBaichuanIntercom } from "../src/intercom";

/**
 * Issue #17 — two-way audio never reached the camera.
 *
 * Every intercom session logged `method SETUP failed: 461 Unsupported
 * Transport`, because `buildFfmpegPcmArgs` stripped `-rtsp_transport` from the
 * inherited FFmpegInput. The stated reason was that the local relay only spoke
 * RTP/UDP; the opposite is true. Scrypted's `RtspServer.setup()` accepts TCP
 * unconditionally and answers anything else with 461 unless it was constructed
 * with the opt-in `udp` flag (see scrypted/common/src/rtsp-server.ts).
 *
 * Stripping the flag therefore left ffmpeg on its default, which probes UDP
 * first. That wasted a round trip on every session, and with
 * `-analyzeduration 0 -probesize 512` there was frequently not enough margin
 * for the TCP retry to produce audio before the 10s startup timeout.
 */

// `buildFfmpegPcmArgs` is private; the behaviour under test is what it puts on
// the command line, so reach it through the prototype rather than reshaping the
// class for the test.
function buildArgs(ffmpegInput: unknown, logger?: unknown): string[] {
  const build = (ReolinkBaichuanIntercom.prototype as any).buildFfmpegPcmArgs;
  return build.call({}, ffmpegInput, {
    sampleRate: 16000,
    channels: 1,
    ...(logger ? { logger } : {}),
  });
}

function decoderOf(args: string[]): string | undefined {
  const i = args.indexOf("-acodec");
  return i === -1 ? undefined : args[i + 1];
}

function transportOf(args: string[]): string | undefined {
  const i = args.indexOf("-rtsp_transport");
  return i === -1 ? undefined : args[i + 1];
}

describe("intercom ffmpeg transport selection (issue #17)", () => {
  it("pins RTSP inputs to TCP when the caller did not specify a transport", () => {
    const args = buildArgs({
      url: "rtsp://127.0.0.1:42077",
      inputArguments: ["-i", "rtsp://127.0.0.1:42077"],
    });

    expect(transportOf(args)).toBe("tcp");
  });

  it("puts the transport before -i, or the demuxer never sees it", () => {
    const args = buildArgs({
      url: "rtsp://127.0.0.1:42077",
      inputArguments: ["-i", "rtsp://127.0.0.1:42077"],
    });

    // Guard against passing vacuously when the flag is absent altogether.
    expect(args).toContain("-rtsp_transport");
    expect(args.indexOf("-rtsp_transport")).toBeLessThan(args.indexOf("-i"));
  });

  it("preserves a transport the caller did specify", () => {
    // The regression: this value used to be discarded.
    const args = buildArgs({
      url: "rtsp://127.0.0.1:42077",
      inputArguments: [
        "-rtsp_transport",
        "tcp",
        "-i",
        "rtsp://127.0.0.1:42077",
      ],
    });

    expect(transportOf(args)).toBe("tcp");
    expect(args.filter((a) => a === "-rtsp_transport")).toHaveLength(1);
  });

  it("does not override an explicit udp request", () => {
    // A relay built with the `udp` flag is legal; honour what the caller asked.
    const args = buildArgs({
      url: "rtsp://127.0.0.1:42077",
      inputArguments: [
        "-rtsp_transport",
        "udp",
        "-i",
        "rtsp://127.0.0.1:42077",
      ],
    });

    expect(transportOf(args)).toBe("udp");
  });

  it("leaves non-RTSP inputs alone", () => {
    const args = buildArgs({
      url: "tcp://127.0.0.1:5000",
      inputArguments: ["-i", "tcp://127.0.0.1:5000"],
    });

    expect(transportOf(args)).toBeUndefined();
  });

  it("still collapses multiple inputs down to the first", () => {
    const args = buildArgs({
      url: "rtsp://127.0.0.1:1",
      inputArguments: [
        "-i",
        "rtsp://127.0.0.1:1",
        "-i",
        "rtsp://127.0.0.1:2",
      ],
    });

    expect(args.filter((a) => a === "-i")).toHaveLength(1);
    expect(args[args.indexOf("-i") + 1]).toBe("rtsp://127.0.0.1:1");
  });
});

/**
 * Talkback worked from Scrypted's own UI but not from an iPhone.
 *
 * Scrypted's HomeKit plugin names the return-audio decoder explicitly —
 * `["-acodec", isOpus ? "libopus" : "libfdk_aac", "-i", rtspUrl]` — and both
 * names are ffmpeg build options. When the local build lacks one, ffmpeg prints
 * `Unknown decoder` and exits before opening the input. The WebRTC path passes
 * no decoder override, which is exactly why it was unaffected.
 */
describe("intercom input decoder rewriting (HomeKit talkback)", () => {
  it("rewrites libopus to the built-in opus decoder", () => {
    const args = buildArgs({
      url: "rtsp://127.0.0.1:42077",
      inputArguments: ["-acodec", "libopus", "-i", "rtsp://127.0.0.1:42077"],
    });

    expect(decoderOf(args)).toBe("opus");
    expect(args).not.toContain("libopus");
  });

  it("rewrites libfdk_aac to the built-in aac decoder", () => {
    // The non-free one: absent from essentially every distributed ffmpeg.
    const args = buildArgs({
      url: "rtsp://127.0.0.1:42077",
      inputArguments: ["-acodec", "libfdk_aac", "-i", "rtsp://127.0.0.1:42077"],
    });

    expect(decoderOf(args)).toBe("aac");
    expect(args).not.toContain("libfdk_aac");
  });

  it("keeps the decoder before -i, where it selects the input decoder", () => {
    const args = buildArgs({
      url: "rtsp://127.0.0.1:42077",
      inputArguments: ["-acodec", "libopus", "-i", "rtsp://127.0.0.1:42077"],
    });

    expect(args.indexOf("-acodec")).toBeLessThan(args.indexOf("-i"));
  });

  it("handles the -c:a spelling too", () => {
    const args = buildArgs({
      url: "rtsp://127.0.0.1:42077",
      inputArguments: ["-c:a", "libopus", "-i", "rtsp://127.0.0.1:42077"],
    });

    expect(args[args.indexOf("-c:a") + 1]).toBe("opus");
  });

  it("leaves a decoder that is always available alone", () => {
    const args = buildArgs({
      url: "rtsp://127.0.0.1:42077",
      inputArguments: ["-acodec", "pcm_mulaw", "-i", "rtsp://127.0.0.1:42077"],
    });

    expect(decoderOf(args)).toBe("pcm_mulaw");
  });

  it("does not disturb the output encoder, which is also -acodec", () => {
    const args = buildArgs({
      url: "rtsp://127.0.0.1:42077",
      inputArguments: ["-acodec", "libopus", "-i", "rtsp://127.0.0.1:42077"],
    });

    // The last -acodec is the output one and must stay pcm_s16le.
    const last = args.lastIndexOf("-acodec");
    expect(args[last + 1]).toBe("pcm_s16le");
    expect(last).toBeGreaterThan(args.indexOf("-i"));
  });

  it("says what it rewrote, so the next log explains itself", () => {
    const lines: string[] = [];
    buildArgs(
      {
        url: "rtsp://127.0.0.1:42077",
        inputArguments: ["-acodec", "libfdk_aac", "-i", "rtsp://127.0.0.1:42077"],
      },
      { log: (m: string) => lines.push(m) },
    );

    expect(lines.join("\n")).toMatch(/libfdk_aac.*aac/);
  });

  it("still applies the TCP transport fix alongside the rewrite", () => {
    // The real HomeKit shape: a decoder override and no transport.
    const args = buildArgs({
      url: "rtsp://127.0.0.1:42077",
      inputArguments: ["-acodec", "libopus", "-i", "rtsp://127.0.0.1:42077"],
    });

    expect(decoderOf(args)).toBe("opus");
    expect(transportOf(args)).toBe("tcp");
  });
});
