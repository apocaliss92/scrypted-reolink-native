import type { ReolinkBaichuanApi } from "@apocaliss92/nodelink-js" with {
  "resolution-mode": "import",
};

// Lazy ESM bridge: scrypted-reolink-native is CJS-compiled but
// @apocaliss92/nodelink-js is an ESM-only package, so any value
// (non-type) imports have to go through dynamic import. Cached on the
// first call so the PCM pump doesn't re-resolve the module per chunk.
let encodeImaAdpcmFn:
  | ((pcm: Int16Array, blockSizeBytes: number) => Buffer)
  | undefined;
async function loadEncodeImaAdpcm(): Promise<
  (pcm: Int16Array, blockSizeBytes: number) => Buffer
> {
  if (encodeImaAdpcmFn) return encodeImaAdpcmFn;
  const mod = await import("@apocaliss92/nodelink-js");
  encodeImaAdpcmFn = mod.encodeImaAdpcm;
  return encodeImaAdpcmFn;
}
import sdk, {
  FFmpegInput,
  MediaObject,
  ScryptedMimeTypes,
} from "@scrypted/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Abstraction over the camera-specific dependencies needed by the intercom engine.
 * Both ReolinkCamera (internal) and IntercomMixin (standalone) can implement this.
 */
export interface IntercomHost {
  readonly blocksPerPayload: number;
  readonly outputGain: number;
  readonly maxBacklogMs: number;
  readonly channel: number;
  readonly isBatteryCamera: boolean;
  readonly deviceId: string;
  readonly logger: Console;
  ensureApi(): Promise<ReolinkBaichuanApi>;
  withRetry<T>(fn: () => Promise<T>): Promise<T>;
}

// Keep this low: Reolink blocks are ~64ms at 16kHz (1025 samples).
// A small backlog avoids multi-second latency when the pipeline stalls.
// Aim for ~1 block of latency (a block is ~64ms at 16kHz for Reolink talk).
// This clamps the internal buffer to (approximately) one block.
const DEFAULT_MAX_BACKLOG_MS = 120;

/**
 * Input decoders that ffmpeg only has when it was compiled with the matching
 * external library, mapped to the built-in decoder for the same codec.
 *
 * Scrypted's HomeKit plugin names the return-audio decoder explicitly:
 *
 *     inputArguments: ["-acodec", isOpus ? "libopus" : "libfdk_aac", "-i", rtspUrl]
 *
 * Both names are build options. `libfdk_aac` is non-free and is left out of
 * essentially every distributed ffmpeg; `libopus` is common but not guaranteed.
 * When the name is missing ffmpeg does not fall back — it prints
 * `Unknown decoder '...'` and exits before opening the input, so talkback dies
 * instantly with no audio.
 *
 * The built-in `opus` and `aac` decoders are always compiled in, and the
 * built-in AAC decoder handles the AAC-ELD profile HomeKit uses. Rewriting
 * keeps the caller's intent (decode this codec) while dropping the dependency
 * on how the local ffmpeg happened to be built.
 *
 * This only bites the HomeKit path: Scrypted's own WebRTC path passes no
 * decoder override at all, which is why talkback worked everywhere except from
 * an iPhone.
 */
const NATIVE_DECODER_EQUIVALENTS: Record<string, string> = {
  libopus: "opus",
  libfdk_aac: "aac",
};

/** `-acodec` and the `-c:a` family both select the audio decoder before `-i`. */
function isAudioDecoderFlag(arg: string | undefined): boolean {
  return arg === "-acodec" || arg === "-c:a" || /^-c:a:\d+$/.test(arg ?? "");
}

/**
 * Explain a talkback session that produced no audio.
 *
 * The old message — "no PCM data received" — was true of two failures with
 * opposite causes, and field logs contain both:
 *
 *  - ffmpeg opened the RTSP input and then nothing arrived on it. The relay
 *    works; the client is not sending microphone audio.
 *  - ffmpeg never opened the input. `Input #0` is emitted by dump_format()
 *    once avformat_open_input has finished OPTIONS/DESCRIBE/SETUP/PLAY and
 *    needs no RTP to appear, so its absence means the handshake with
 *    Scrypted's local relay never completed. The client's microphone was
 *    never even reached.
 *
 * stderr is never fully buffered in C, so "ffmpeg printed nothing" is a real
 * observation rather than output lost to a pipe buffer on SIGKILL.
 */
export function describeStartupFailure(props: {
  inputOpenedAtMs?: number | undefined;
  stderrBytes: number;
}): string {
  const { inputOpenedAtMs, stderrBytes } = props;

  if (inputOpenedAtMs !== undefined) {
    return (
      `ffmpeg opened the RTSP input after ${inputOpenedAtMs}ms but no audio ever arrived on it. ` +
      `The relay is working, so the client is not sending microphone audio — check that the ` +
      `app/browser actually captured the mic (on iOS the orange recording indicator should be ` +
      `lit) and that it is on a secure origin, since navigator.mediaDevices is unavailable over ` +
      `plain http.`
    );
  }

  if (stderrBytes > 0) {
    return (
      `ffmpeg never opened the RTSP input (${stderrBytes} bytes of stderr, no "Input #" banner). ` +
      `It did not get past the RTSP handshake with Scrypted's local relay.`
    );
  }

  return (
    `ffmpeg produced no output whatsoever. It is stuck before the RTSP input opened, i.e. the ` +
    `handshake with Scrypted's local relay never completed — the client audio itself was never ` +
    `reached, so this is not a microphone problem.`
  );
}

export class ReolinkBaichuanIntercom {
  private session:
    | Awaited<ReturnType<ReolinkBaichuanApi["createDedicatedTalkSession"]>>
    | undefined;
  private ffmpeg: ChildProcessWithoutNullStreams | undefined;
  private stopping: Promise<void> | undefined;
  private loggedCodecInfo = false;

  private maxBacklogMs = DEFAULT_MAX_BACKLOG_MS;
  private maxBacklogBytes: number | undefined;

  // PCM backlog held as a queue of chunks instead of a single growing Buffer,
  // so the hot enqueue path no longer does a Buffer.concat per audio chunk.
  // `pcmHeadOffset` is the number of bytes already consumed from pcmChunks[0];
  // `pcmQueuedBytes` is the logical (unconsumed) byte length of the queue.
  private pcmChunks: Buffer[] = [];
  private pcmHeadOffset = 0;
  private pcmQueuedBytes = 0;

  private pumping = false;
  private pumpPromise: Promise<void> | undefined;

  private lastBacklogClampLogAtMs = 0;
  private droppedBytesSinceLog = 0;
  private clampCountSinceLog = 0;
  /** Session totals, reported once when ffmpeg exits. */
  private payloadsSent = 0;
  private totalDroppedBytes = 0;
  /** s16 mono byte rate of the talk session, used to report drops in ms. */
  private pcmBytesPerSecond = 0;

  constructor(private host: IntercomHost) {}

  async start(media: MediaObject): Promise<void> {
    const logger = this.host.logger;

    const ffmpegInput =
      await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(
        media,
        ScryptedMimeTypes.FFmpegInput,
      );

    await this.stop();
    const channel = this.host.channel;

    try {
      // Get the main API - library manages dedicated sockets internally
      const api = await this.host.withRetry(async () => {
        return await this.host.ensureApi();
      });

      // Best-effort: log codec requirements exposed by the camera.
      if (!this.loggedCodecInfo) {
        this.loggedCodecInfo = true;
        try {
          const ability = await api.getTalkAbility(channel);
          logger.log("Intercom TalkAbility", {
            channel,
            duplexList: ability.duplexList,
            audioStreamModeList: ability.audioStreamModeList,
            audioConfigList: ability.audioConfigList,
          });
        } catch (e) {
          logger.warn(
            "Intercom: unable to fetch TalkAbility",
            e?.message || String(e),
          );
        }
      }

      // For UDP/battery cameras, wake up the camera if it's sleeping before creating talk session
      if (this.host.isBatteryCamera) {
        try {
          const sleepStatus = api.getSleepStatus({ channel });
          if (sleepStatus.state === "sleeping") {
            logger.log("Camera is sleeping, waking up for intercom...");
            await api.wakeUp(channel, { waitAfterWakeMs: 2000 });
            // Wait a bit more to ensure camera is fully awake
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } catch (e) {
          logger.debug(
            "Failed to check/wake camera for intercom, proceeding anyway",
            e?.message || String(e),
          );
        }
      }

      // Use createDedicatedTalkSession - library manages dedicated socket internally
      // with auto-teardown on idle or when stop() is called
      const blocksPerPayload = this.host.blocksPerPayload;
      const session = await this.host.withRetry(async () => {
        return await api.createDedicatedTalkSession(channel, {
          blocksPerPayload,
          idleTimeoutMs: 30000, // Auto-teardown if no audio for 30s
          deviceId: this.host.deviceId,
          logger,
        });
      });

      this.session = session;
      this.resetPcmQueue();
      this.lastBacklogClampLogAtMs = 0;
      this.droppedBytesSinceLog = 0;
      this.clampCountSinceLog = 0;
      this.payloadsSent = 0;
      this.totalDroppedBytes = 0;
      this.pumping = false;
      this.pumpPromise = undefined;

      const { audioConfig, blockSize, fullBlockSize } = session.info;
      const sampleRate = audioConfig.sampleRate;

      // Configurable backlog to trade latency vs stability.
      // If the pipeline (ffmpeg decode + encode + send) can't keep up,
      // dropping old audio avoids accumulating multi-second latency.
      const configuredBacklog = Number(this.host.maxBacklogMs);
      if (Number.isFinite(configuredBacklog)) {
        this.maxBacklogMs = Math.max(20, Math.min(5000, configuredBacklog));
      } else {
        this.maxBacklogMs = DEFAULT_MAX_BACKLOG_MS;
      }

      // Mirror native-api.ts: receive PCM s16le from the forwarder and encode IMA ADPCM in JS.
      const samplesPerBlock = blockSize * 2 + 1;
      const bytesNeeded = samplesPerBlock * 2; // Int16 PCM
      // bytes/sec = sampleRate * channels * 2 (s16)
      this.pcmBytesPerSecond = sampleRate * 1 * 2;
      this.maxBacklogBytes = Math.max(
        bytesNeeded,
        Math.floor((this.maxBacklogMs / 1000) * this.pcmBytesPerSecond),
      );

      if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
        await this.stop();
        throw new Error(`Invalid talk sampleRate: ${sampleRate}`);
      }
      if (
        !Number.isFinite(blockSize) ||
        blockSize <= 0 ||
        !Number.isFinite(fullBlockSize) ||
        fullBlockSize !== blockSize + 4
      ) {
        await this.stop();
        throw new Error(
          `Invalid talk block sizes: blockSize=${blockSize} fullBlockSize=${fullBlockSize}`,
        );
      }

      logger.log("Starting intercom (baichuan/native-api flow)", {
        channel,
        audioType: audioConfig.audioType,
        sampleRate: audioConfig.sampleRate,
        samplePrecision: audioConfig.samplePrecision,
        lengthPerEncoder: audioConfig.lengthPerEncoder,
        soundTrack: audioConfig.soundTrack,
        blockSize,
        fullBlockSize,
        samplesPerBlock,
        bytesNeeded,
        maxBacklogMs: this.maxBacklogMs,
        maxBacklogBytes: this.maxBacklogBytes,
        blocksPerPayload,
      });

      // IMPORTANT: incoming audio from Scrypted/WebRTC is typically Opus.
      // We must decode to PCM before IMA ADPCM encoding, otherwise it will be noise.
      const gain = this.host.outputGain;
      const ffmpegArgs = this.buildFfmpegPcmArgs(ffmpegInput, {
        sampleRate,
        channels: 1,
        gain,
        logger,
      });

      logger.log("Intercom ffmpeg decode args", ffmpegArgs);

      // Diagnostics for the "talkback silently does nothing" reports.
      //
      // The field logs show two shapes that the old single message
      // ("no PCM data received") could not tell apart, and which have opposite
      // causes:
      //
      //  - ffmpeg prints nothing at all for the whole window. `Input #0` is
      //    emitted by dump_format() once avformat_open_input has completed
      //    OPTIONS/DESCRIBE/SETUP/PLAY, and needs no RTP to appear, so silence
      //    means the RTSP handshake with Scrypted's relay never completed.
      //    (stderr is never fully buffered in C, so this is real output, not a
      //    flush artefact.)
      //  - ffmpeg opens the input and then sits there. The relay is fine and
      //    the client simply is not sending microphone audio.
      //
      // These are logged unconditionally rather than behind the debug flag: a
      // talk session is short and user-initiated, so the volume is bounded, and
      // the whole point is to have the answer already in the log the reporter
      // sends rather than asking them to reproduce with debug enabled.
      const spawnedAtMs = Date.now();
      const sinceSpawn = () => Date.now() - spawnedAtMs;
      let inputOpenedAtMs: number | undefined;
      let stderrBytes = 0;
      let pcmBytes = 0;

      const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (this.session !== session) {
        try {
          ffmpeg.kill("SIGKILL");
        } catch {}
        return;
      }

      this.ffmpeg = ffmpeg;

      // Startup timeout: if ffmpeg has not produced any PCM output within
      // this window it is likely stuck on RTSP connection negotiation.
      // Kill it early with a clear error rather than hanging silently.
      const STARTUP_TIMEOUT_MS = 10_000;
      let receivedFirstPcm = false;
      const startupTimer = setTimeout(() => {
        if (!receivedFirstPcm && this.ffmpeg === ffmpeg) {
          const diagnosis = describeStartupFailure({
            inputOpenedAtMs,
            stderrBytes,
          });

          logger.warn(
            `Intercom ffmpeg startup timeout (${STARTUP_TIMEOUT_MS}ms), killing process. ${diagnosis}`,
          );
          try {
            ffmpeg.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, STARTUP_TIMEOUT_MS);

      ffmpeg.stdout.on("data", (chunk: Buffer) => {
        if (this.session !== session) return;
        if (!chunk?.length) return;
        pcmBytes += chunk.length;
        if (!receivedFirstPcm) {
          receivedFirstPcm = true;
          clearTimeout(startupTimer);
          logger.log(
            `Intercom ffmpeg: first PCM data received after ${sinceSpawn()}ms` +
              (inputOpenedAtMs !== undefined
                ? ` (RTSP input opened at ${inputOpenedAtMs}ms)`
                : ""),
          );
        }
        this.enqueuePcm(session, chunk, bytesNeeded, blockSize);
      });

      let stderrLines = 0;
      ffmpeg.stderr.on("data", (d: Buffer) => {
        stderrBytes += d.length;
        const text = d.toString();

        // dump_format() runs once the input is open. Recording when that
        // happened is what separates "the relay never answered" from "the
        // relay is fine, the client is silent".
        if (inputOpenedAtMs === undefined && text.includes("Input #")) {
          inputOpenedAtMs = sinceSpawn();
          logger.log(
            `Intercom ffmpeg: RTSP input opened after ${inputOpenedAtMs}ms`,
          );
        }

        // Raised from 12: the interesting failures are the quiet ones, and a
        // truncated tail is exactly what makes them unreadable. Still bounded.
        if (stderrLines++ < 40) {
          logger.warn(`Intercom ffmpeg [+${sinceSpawn()}ms]`, text.trim());
        }
      });

      ffmpeg.on("exit", (code, signal) => {
        clearTimeout(startupTimer);
        // One line that says what the session actually did. Today a failed
        // session and a working one look nearly identical in the log, and
        // neither reports how much audio moved in either direction.
        logger.warn(`Intercom ffmpeg exited code=${code} signal=${signal}`, {
          durationMs: sinceSpawn(),
          rtspInputOpenedAtMs: inputOpenedAtMs ?? null,
          pcmBytesFromClient: pcmBytes,
          pcmMsFromClient: this.pcmBytesPerSecond
            ? Math.round((pcmBytes / this.pcmBytesPerSecond) * 1000)
            : null,
          adpcmPayloadsSentToCamera: this.payloadsSent,
          droppedPcmBytes: this.totalDroppedBytes,
          ffmpegStderrBytes: stderrBytes,
        });
        this.stop().catch(() => {});
      });

      logger.log("Intercom started (ffmpeg decode -> PCM -> IMA ADPCM)");
    } catch (e) {
      // Ensure the dedicated session gets torn down even if start fails half-way.
      await this.stop();
      throw e;
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;

    this.stopping = (async () => {
      const logger = this.host.logger;

      const ffmpeg = this.ffmpeg;
      this.ffmpeg = undefined;

      const session = this.session;
      this.session = undefined;

      this.resetPcmQueue();

      const sleepMs = async (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));

      if (ffmpeg && ffmpeg.exitCode == null) {
        try {
          ffmpeg.kill("SIGKILL");
        } catch {
          // ignore
        }

        try {
          await Promise.race([
            new Promise<void>((resolve) =>
              ffmpeg.once("exit", () => resolve()),
            ),
            sleepMs(1000),
          ]);
        } catch {
          // ignore
        }
      }

      try {
        await Promise.race([
          this.pumpPromise ?? Promise.resolve(),
          sleepMs(250),
        ]);
      } catch {
        // ignore
      }
      this.pumpPromise = undefined;

      // session.stop() handles socket teardown - library manages dedicated socket internally
      if (session) {
        try {
          await Promise.race([session.stop(), sleepMs(2000)]);
        } catch (e) {
          logger.warn("Intercom session stop error", e?.message || String(e));
        }
      }
    })().finally(() => {
      this.stopping = undefined;
    });

    return this.stopping;
  }

  /** Reset the PCM backlog queue. */
  private resetPcmQueue(): void {
    this.pcmChunks = [];
    this.pcmHeadOffset = 0;
    this.pcmQueuedBytes = 0;
  }

  /**
   * Drop the oldest `dropBytes` bytes from the front of the queue, advancing
   * the head offset and discarding fully-consumed chunks. Used by the backlog
   * clamp; preserves the same "drop oldest samples" semantics as the previous
   * single-buffer `subarray(length - keep)`.
   */
  private dropOldestPcm(dropBytes: number): void {
    let remaining = dropBytes;
    while (remaining > 0 && this.pcmChunks.length) {
      const head = this.pcmChunks[0];
      const avail = head.length - this.pcmHeadOffset;
      if (avail <= remaining) {
        remaining -= avail;
        this.pcmChunks.shift();
        this.pcmHeadOffset = 0;
      } else {
        this.pcmHeadOffset += remaining;
        remaining = 0;
      }
    }
    this.pcmQueuedBytes -= dropBytes - remaining;
  }

  /**
   * Materialize and remove the next `bytesNeeded` contiguous bytes from the
   * front of the queue. Returns a freshly-allocated Buffer (its own backing
   * store, so it is safe to wrap in an Int16Array). Caller must ensure
   * `pcmQueuedBytes >= bytesNeeded`.
   */
  private takePcm(bytesNeeded: number): Buffer {
    const out = Buffer.allocUnsafe(bytesNeeded);
    let written = 0;
    while (written < bytesNeeded && this.pcmChunks.length) {
      const head = this.pcmChunks[0];
      const avail = head.length - this.pcmHeadOffset;
      const take = Math.min(avail, bytesNeeded - written);
      head.copy(out, written, this.pcmHeadOffset, this.pcmHeadOffset + take);
      written += take;
      if (take === avail) {
        this.pcmChunks.shift();
        this.pcmHeadOffset = 0;
      } else {
        this.pcmHeadOffset += take;
      }
    }
    this.pcmQueuedBytes -= bytesNeeded;
    return out;
  }

  private enqueuePcm(
    session: Awaited<ReturnType<ReolinkBaichuanApi["createTalkSession"]>>,
    pcmChunk: Buffer,
    bytesNeeded: number,
    blockSize: number,
  ): void {
    const logger = this.host.logger;

    if (this.session !== session) return;

    // Hot path: append the chunk reference, no per-chunk concat.
    if (pcmChunk.length) {
      this.pcmChunks.push(pcmChunk);
      this.pcmQueuedBytes += pcmChunk.length;
    }

    // Cap backlog to keep latency bounded (drop oldest samples).
    // IMPORTANT: do this on the shared queue (not in a promise chain),
    // otherwise old PCM chunks can pile up in queued closures and bypass
    // this clamp, causing multi-second latency and degraded audio.
    const maxBytes = this.maxBacklogBytes ?? bytesNeeded;
    if (this.pcmQueuedBytes > maxBytes) {
      // Align to 16-bit samples.
      const keep = maxBytes - (maxBytes % 2);
      const dropped = this.pcmQueuedBytes - keep;
      this.dropOldestPcm(dropped);

      // Accumulate across the rate-limit window. Logging only the most recent
      // clamp made a continuously-starved pipeline look like it was dropping a
      // couple hundred bytes every two seconds, when the real figure is the sum
      // of every clamp in between (issue #17).
      this.droppedBytesSinceLog += dropped;
      this.totalDroppedBytes += dropped;
      this.clampCountSinceLog++;

      const now = Date.now();
      if (now - this.lastBacklogClampLogAtMs > 2000) {
        const windowMs = this.lastBacklogClampLogAtMs
          ? now - this.lastBacklogClampLogAtMs
          : 0;
        // bytes -> ms of audio: s16 mono at the talk session's sample rate.
        const bytesPerMs = (this.pcmBytesPerSecond || 0) / 1000;
        logger.warn("Intercom backlog clamped (dropping PCM)", {
          droppedBytes: this.droppedBytesSinceLog,
          clamps: this.clampCountSinceLog,
          windowMs,
          droppedAudioMs: bytesPerMs
            ? Math.round(this.droppedBytesSinceLog / bytesPerMs)
            : undefined,
          keptBytes: keep,
          maxBytes,
        });
        this.lastBacklogClampLogAtMs = now;
        this.droppedBytesSinceLog = 0;
        this.clampCountSinceLog = 0;
      }
    }

    if (this.pumping) return;

    this.pumping = true;
    this.pumpPromise = (async () => {
      try {
        const encode = await loadEncodeImaAdpcm();
        while (true) {
          if (this.session !== session) return;
          if (this.pcmQueuedBytes < bytesNeeded) return;

          const chunk = this.takePcm(bytesNeeded);

          const pcmSamples = new Int16Array(
            chunk.buffer,
            chunk.byteOffset,
            chunk.length / 2,
          );

          const adpcmChunk = encode(pcmSamples, blockSize);
          await session.sendAudio(adpcmChunk);
          this.payloadsSent++;
        }
      } catch (e) {
        logger.warn(
          "Intercom PCM->ADPCM pipeline error",
          e?.message || String(e),
        );
      } finally {
        this.pumping = false;
      }
    })();
  }

  private buildFfmpegPcmArgs(
    ffmpegInput: FFmpegInput,
    options: {
      sampleRate: number;
      channels: number;
      gain?: number;
      logger?: any;
    },
  ): string[] {
    const inputArgs = ffmpegInput.inputArguments ?? [];

    // FFmpegInput may already contain one or more "-i" entries.
    // For intercom decode, we only need a single input and only the first audio stream.
    //
    // Transport note (issue #17): this used to strip `-rtsp_transport` on the
    // theory that the local relay only spoke RTP/UDP. That is backwards.  The
    // URL points at a Scrypted `RtspServer`, whose SETUP handler accepts TCP
    // unconditionally but answers UDP with `461 Unsupported Transport` unless
    // it was constructed with the opt-in `udp` flag — which the intercom
    // relays are not.  Dropping the flag left ffmpeg on its default, which
    // tries UDP first: every session paid a failed SETUP round trip, and with
    // `-analyzeduration 0 -probesize 512` there was often not enough margin
    // left for the TCP retry to deliver audio before the startup timeout.
    //
    // So: keep whatever transport the upstream FFmpegInput asked for, and when
    // it does not ask, pin RTSP inputs to TCP ourselves.
    const sanitizedArgs: string[] = [];
    let chosenInput: string | undefined;
    let hasRtspTransport = false;

    for (let i = 0; i < inputArgs.length; i++) {
      const arg = inputArgs[i];
      if (arg === "-i") {
        const maybeUrl = inputArgs[i + 1];
        if (typeof maybeUrl === "string") {
          if (!chosenInput) {
            chosenInput = maybeUrl;
          }
          // Skip all inputs after the first.
          i++;
          continue;
        }
      }

      if (arg === "-rtsp_transport") {
        hasRtspTransport = true;
      }

      // Input decoder override: rewrite optional external decoders to the
      // built-in equivalent. See NATIVE_DECODER_EQUIVALENTS.
      if (isAudioDecoderFlag(arg)) {
        const requested = inputArgs[i + 1];
        const native = requested
          ? NATIVE_DECODER_EQUIVALENTS[requested]
          : undefined;
        if (native) {
          options.logger?.log?.(
            `Intercom: input decoder '${requested}' rewritten to '${native}' ` +
              `(the built-in decoder is always present; '${requested}' is a build option)`,
          );
          sanitizedArgs.push(arg, native);
          i++;
          continue;
        }
      }

      sanitizedArgs.push(arg);
    }

    const url = chosenInput ?? ffmpegInput.url;
    if (!url) {
      throw new Error("FFmpegInput missing url/input");
    }

    // Only meaningful for RTSP inputs; harmless to omit for anything else.
    if (!hasRtspTransport && url.startsWith("rtsp://")) {
      sanitizedArgs.push("-rtsp_transport", "tcp");
    }

    const gain = options.gain ?? 1.0;
    const hasExistingAudioFilter =
      sanitizedArgs.includes("-af") ||
      sanitizedArgs.includes("-filter:a") ||
      sanitizedArgs.includes("-filter_complex");
    const gainArgs =
      gain !== 1.0
        ? hasExistingAudioFilter
          ? (options.logger?.warn?.(
              "Intercom gain skipped: FFmpegInput already contains audio filters",
            ) ?? undefined,
            [])
          : ["-filter:a", `volume=${gain}`]
        : [];

    return [
      "-hide_banner",

      // Pre-input low-latency flags: these MUST be before -i to affect
      // the input demuxer. Placing them after -i only affects output.
      "-analyzeduration",
      "0",
      "-probesize",
      "512",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",

      ...sanitizedArgs,
      "-i",
      url,

      // Ensure we only decode the first input's audio stream.
      "-map",
      "0:a:0?",

      // Output low-latency settings.
      "-flush_packets",
      "1",

      "-vn",
      "-sn",
      "-dn",
      ...gainArgs,
      "-acodec",
      "pcm_s16le",
      "-ar",
      options.sampleRate.toString(),
      "-ac",
      options.channels.toString(),
      "-f",
      "s16le",
      "pipe:1",
    ];
  }

}
