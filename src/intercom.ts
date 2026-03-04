import type { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js" with {
  "resolution-mode": "import",
};
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

export class ReolinkBaichuanIntercom {
  private session:
    | Awaited<ReturnType<ReolinkBaichuanApi["createDedicatedTalkSession"]>>
    | undefined;
  private ffmpeg: ChildProcessWithoutNullStreams | undefined;
  private stopping: Promise<void> | undefined;
  private loggedCodecInfo = false;

  private maxBacklogMs = DEFAULT_MAX_BACKLOG_MS;
  private maxBacklogBytes: number | undefined;

  private pcmBuffer: Buffer = Buffer.alloc(0);

  private pumping = false;
  private pumpPromise: Promise<void> | undefined;

  private lastBacklogClampLogAtMs = 0;

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
      this.pcmBuffer = Buffer.alloc(0);
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
      this.maxBacklogBytes = Math.max(
        bytesNeeded,
        // bytes/sec = sampleRate * channels * 2 (s16)
        Math.floor((this.maxBacklogMs / 1000) * sampleRate * 1 * 2),
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
          logger.warn(
            `Intercom ffmpeg startup timeout (${STARTUP_TIMEOUT_MS}ms): no PCM data received, killing process`,
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
        if (!receivedFirstPcm) {
          receivedFirstPcm = true;
          clearTimeout(startupTimer);
          logger.log("Intercom ffmpeg: first PCM data received");
        }
        this.enqueuePcm(session, chunk, bytesNeeded, blockSize);
      });

      let stderrLines = 0;
      ffmpeg.stderr.on("data", (d: Buffer) => {
        // Avoid spamming logs.
        if (stderrLines++ < 12) {
          logger.warn("Intercom ffmpeg", d.toString().trim());
        }
      });

      ffmpeg.on("exit", (code, signal) => {
        clearTimeout(startupTimer);
        logger.warn(`Intercom ffmpeg exited code=${code} signal=${signal}`);
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

      this.pcmBuffer = Buffer.alloc(0);

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

  private clamp16(x: number): number {
    if (x > 32767) return 32767;
    if (x < -32768) return -32768;
    return x | 0;
  }

  private enqueuePcm(
    session: Awaited<ReturnType<ReolinkBaichuanApi["createTalkSession"]>>,
    pcmChunk: Buffer,
    bytesNeeded: number,
    blockSize: number,
  ): void {
    const logger = this.host.logger;

    if (this.session !== session) return;

    this.pcmBuffer = this.pcmBuffer.length
      ? Buffer.concat([this.pcmBuffer, pcmChunk])
      : pcmChunk;

    // Cap backlog to keep latency bounded (drop oldest samples).
    // IMPORTANT: do this on the shared buffer (not in a promise chain),
    // otherwise old PCM chunks can pile up in queued closures and bypass
    // this clamp, causing multi-second latency and degraded audio.
    const maxBytes = this.maxBacklogBytes ?? bytesNeeded;
    if (this.pcmBuffer.length > maxBytes) {
      // Align to 16-bit samples.
      const keep = maxBytes - (maxBytes % 2);
      const dropped = this.pcmBuffer.length - keep;
      this.pcmBuffer = this.pcmBuffer.subarray(this.pcmBuffer.length - keep);

      const now = Date.now();
      if (now - this.lastBacklogClampLogAtMs > 2000) {
        this.lastBacklogClampLogAtMs = now;
        logger.warn("Intercom backlog clamped (dropping PCM)", {
          droppedBytes: dropped,
          keptBytes: keep,
          maxBytes,
        });
      }
    }

    if (this.pumping) return;

    this.pumping = true;
    this.pumpPromise = (async () => {
      try {
        while (true) {
          if (this.session !== session) return;
          if (this.pcmBuffer.length < bytesNeeded) return;

          const chunk = this.pcmBuffer.subarray(0, bytesNeeded);
          this.pcmBuffer = this.pcmBuffer.subarray(bytesNeeded);

          const pcmSamples = new Int16Array(
            chunk.buffer,
            chunk.byteOffset,
            chunk.length / 2,
          );

          const adpcmChunk = this.encodeImaAdpcm(pcmSamples, blockSize);
          await session.sendAudio(adpcmChunk);
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
    // IMPORTANT: We must also strip `-rtsp_transport tcp` (and similar transport
    // overrides) inherited from the upstream FFmpegInput.  The RTSP URL points at a
    // local relay server (e.g. from the WebRTC plugin) that typically only supports
    // RTP/UDP.  Forcing TCP causes ffmpeg to hang on SETUP negotiation (the relay
    // replies 461 Unsupported Transport) and eventually get SIGKILLed with no audio
    // ever reaching the intercom pipeline.
    const sanitizedArgs: string[] = [];
    let chosenInput: string | undefined;

    // Set of pre-input flags that take a value argument and should be stripped
    // because they conflict with the local RTSP relay's transport capabilities.
    const stripWithValue = new Set(["-rtsp_transport"]);

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

      // Strip transport-related flags that break the local RTSP relay.
      if (stripWithValue.has(arg)) {
        i++; // skip the value argument as well
        continue;
      }

      sanitizedArgs.push(arg);
    }

    const url = chosenInput ?? ffmpegInput.url;
    if (!url) {
      throw new Error("FFmpegInput missing url/input");
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
      ...sanitizedArgs,
      "-i",
      url,
      // Ensure we only decode the first input's audio stream.
      "-map",
      "0:a:0?",

      // Low-latency decode settings.
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
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

  private encodeImaAdpcm(pcm: Int16Array, blockSizeBytes: number): Buffer {
    const samplesPerBlock = blockSizeBytes * 2 + 1;
    const totalBlocks = Math.ceil(pcm.length / samplesPerBlock);
    const outBlocks: Buffer[] = [];

    const imaIndexTable = Int8Array.from([
      -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8,
    ]);

    const imaStepTable = Int16Array.from([
      7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41,
      45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190,
      209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
      876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
      2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845,
      8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385,
      24623, 27086, 29794, 32767,
    ]);

    let sampleIndex = 0;

    for (let b = 0; b < totalBlocks; b++) {
      const block = Buffer.alloc(4 + blockSizeBytes);

      // Block header
      const first = pcm[sampleIndex] ?? 0;
      let predictor = first;
      let index = 0;

      block.writeInt16LE(predictor, 0);
      block.writeUInt8(index, 2);
      block.writeUInt8(0, 3);

      sampleIndex++;

      // Encode samples into nibbles
      const codes = new Uint8Array(blockSizeBytes * 2);
      for (let i = 0; i < codes.length; i++) {
        const sample = pcm[sampleIndex] ?? predictor;
        sampleIndex++;

        let diff = sample - predictor;
        let sign = 0;
        if (diff < 0) {
          sign = 8;
          diff = -diff;
        }

        let step = imaStepTable[index] ?? 7;
        let delta = 0;
        let vpdiff = step >> 3;

        if (diff >= step) {
          delta |= 4;
          diff -= step;
          vpdiff += step;
        }
        step >>= 1;
        if (diff >= step) {
          delta |= 2;
          diff -= step;
          vpdiff += step;
        }
        step >>= 1;
        if (diff >= step) {
          delta |= 1;
          vpdiff += step;
        }

        if (sign) predictor -= vpdiff;
        else predictor += vpdiff;

        predictor = this.clamp16(predictor);

        index += imaIndexTable[delta] ?? 0;
        if (index < 0) index = 0;
        if (index > 88) index = 88;

        codes[i] = (delta | sign) & 0x0f;
      }

      // Pack nibble: low nibble first, then high nibble
      for (let i = 0; i < blockSizeBytes; i++) {
        const lo = codes[i * 2] ?? 0;
        const hi = codes[i * 2 + 1] ?? 0;
        block[4 + i] = (lo & 0x0f) | ((hi & 0x0f) << 4);
      }

      outBlocks.push(block);
    }

    return Buffer.concat(outBlocks);
  }
}
