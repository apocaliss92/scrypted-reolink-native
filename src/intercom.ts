import type { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { FFmpegInput, MediaObject, ScryptedMimeTypes } from "@scrypted/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ReolinkNativeCamera } from "./camera";

// Keep this low: Reolink blocks are ~64ms at 16kHz (1025 samples).
// A small backlog avoids multi-second latency when the pipeline stalls.
// Aim for ~1 block of latency (a block is ~64ms at 16kHz for Reolink talk).
// This clamps the internal buffer to (approximately) one block.
const DEFAULT_MAX_BACKLOG_MS = 40;

export class ReolinkBaichuanIntercom {
    private session: Awaited<ReturnType<ReolinkBaichuanApi["createTalkSession"]>> | undefined;
    private ffmpeg: ChildProcessWithoutNullStreams | undefined;
    private stopping: Promise<void> | undefined;
    private loggedCodecInfo = false;

    private readonly maxBacklogMs = DEFAULT_MAX_BACKLOG_MS;
    private maxBacklogBytes: number | undefined;

    private sendChain: Promise<void> = Promise.resolve();
    private pcmBuffer: Buffer = Buffer.alloc(0);

    constructor(private camera: ReolinkNativeCamera) {
    }

    get blocksPerPayload(): number {
        return Math.max(1, Math.min(8, this.camera.storageSettings.values.intercomBlocksPerPayload ?? 1));
    }

    async start(media: MediaObject): Promise<void> {
        this.camera.markActivity();
        const logger = this.camera.getLogger();

        const ffmpegInput = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(
            media,
            ScryptedMimeTypes.FFmpegInput,
        );

        await this.stop();
        const channel = this.camera.getRtspChannel();

        // Best-effort: log codec requirements exposed by the camera.
        // This mirrors neolink's source of truth: TalkAbility (cmd_id=10).
        if (!this.loggedCodecInfo) {
            this.loggedCodecInfo = true;
            try {
                const api = await this.camera.ensureClient();
                const ability = await api.getTalkAbility(channel);
                const audioConfigs = ability.audioConfigList?.map((c) => ({
                    audioType: c.audioType,
                    sampleRate: c.sampleRate,
                    samplePrecision: c.samplePrecision,
                    lengthPerEncoder: c.lengthPerEncoder,
                    soundTrack: c.soundTrack,
                }));
                logger.log("Intercom TalkAbility", {
                    channel,
                    duplexList: ability.duplexList,
                    audioStreamModeList: ability.audioStreamModeList,
                    audioConfigList: audioConfigs,
                });
            }
            catch (e) {
                logger.warn("Intercom: unable to fetch TalkAbility", e);
            }
        }

        const session = await this.camera.withBaichuanRetry(async () => {
            const api = await this.camera.ensureClient();
            return await api.createTalkSession(channel, {
                blocksPerPayload: this.blocksPerPayload,
            });
        });

        this.session = session;
        this.pcmBuffer = Buffer.alloc(0);
        this.sendChain = Promise.resolve();

        const { audioConfig, blockSize, fullBlockSize } = session.info;
        const sampleRate = audioConfig.sampleRate;

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
        if (!Number.isFinite(blockSize) || blockSize <= 0 || !Number.isFinite(fullBlockSize) || fullBlockSize !== blockSize + 4) {
            await this.stop();
            throw new Error(`Invalid talk block sizes: blockSize=${blockSize} fullBlockSize=${fullBlockSize}`);
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
            blocksPerPayload: this.blocksPerPayload,
        });

        // IMPORTANT: incoming audio from Scrypted/WebRTC is typically Opus.
        // We must decode to PCM before IMA ADPCM encoding, otherwise it will be noise.
        const ffmpegArgs = this.buildFfmpegPcmArgs(ffmpegInput, {
            sampleRate,
            channels: 1,
        });

        logger.log("Intercom ffmpeg decode args", ffmpegArgs);

        const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
            stdio: ["ignore", "pipe", "pipe"],
        });

        if (this.session !== session) {
            try { ffmpeg.kill("SIGKILL"); } catch { }
            return;
        }

        this.ffmpeg = ffmpeg;

        ffmpeg.stdout.on("data", (chunk: Buffer) => {
            if (this.session !== session) return;
            if (!chunk?.length) return;
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
            logger.warn(`Intercom ffmpeg exited code=${code} signal=${signal}`);
            this.stop().catch(() => { });
        });

        logger.log("Intercom started (ffmpeg decode -> PCM -> IMA ADPCM)");
    }

    stop(): Promise<void> {
        if (this.stopping) return this.stopping;

        this.stopping = (async () => {
            const logger = this.camera.getLogger();

            const ffmpeg = this.ffmpeg;
            this.ffmpeg = undefined;

            const session = this.session;
            this.session = undefined;

            this.pcmBuffer = Buffer.alloc(0);

            const sleepMs = async (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

            if (ffmpeg && ffmpeg.exitCode == null) {
                try {
                    ffmpeg.kill("SIGKILL");
                }
                catch {
                    // ignore
                }

                try {
                    await Promise.race([
                        new Promise<void>((resolve) => ffmpeg.once("exit", () => resolve())),
                        sleepMs(1000),
                    ]);
                }
                catch {
                    // ignore
                }
            }

            try {
                await Promise.race([this.sendChain, sleepMs(250)]);
            }
            catch {
                // ignore
            }
            this.sendChain = Promise.resolve();

            if (session) {
                try {
                    await Promise.race([session.stop(), sleepMs(2000)]);
                }
                catch (e) {
                    logger.warn("Intercom session stop error", e);
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
        const logger = this.camera.getLogger();

        this.sendChain = this.sendChain
            .then(async () => {
                if (this.session !== session) return;

                this.pcmBuffer = this.pcmBuffer.length
                    ? Buffer.concat([this.pcmBuffer, pcmChunk])
                    : pcmChunk;

                // Cap backlog to keep latency bounded (drop oldest samples).
                const maxBytes = this.maxBacklogBytes ?? bytesNeeded;
                if (this.pcmBuffer.length > maxBytes) {
                    // Align to 16-bit samples.
                    const keep = maxBytes - (maxBytes % 2);
                    this.pcmBuffer = this.pcmBuffer.subarray(this.pcmBuffer.length - keep);
                }

                while (this.pcmBuffer.length >= bytesNeeded) {
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
            })
            .catch((e) => {
                logger.warn("Intercom PCM->ADPCM pipeline error", e);
            });
    }

    private buildFfmpegPcmArgs(
        ffmpegInput: FFmpegInput,
        options: {
            sampleRate: number;
            channels: number;
        },
    ): string[] {
        const inputArgs = ffmpegInput.inputArguments ?? [];

        // FFmpegInput may already contain one or more "-i" entries.
        // For intercom decode, we only need a single input and only the first audio stream.
        const sanitizedArgs: string[] = [];
        let chosenInput: string | undefined;

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

            sanitizedArgs.push(arg);
        }

        const url = chosenInput ?? ffmpegInput.url;
        if (!url) {
            throw new Error("FFmpegInput missing url/input");
        }

        return [
            ...sanitizedArgs,
            "-i", url,
            // Ensure we only decode the first input's audio stream.
            "-map", "0:a:0?",

            // Low-latency decode settings.
            "-fflags", "nobuffer",
            "-flags", "low_delay",
            "-flush_packets", "1",

            "-vn", "-sn", "-dn",
            "-acodec", "pcm_s16le",
            "-ar", options.sampleRate.toString(),
            "-ac", options.channels.toString(),
            "-f", "s16le",
            "pipe:1",
        ];
    }

    private encodeImaAdpcm(pcm: Int16Array, blockSizeBytes: number): Buffer {
        const samplesPerBlock = blockSizeBytes * 2 + 1;
        const totalBlocks = Math.ceil(pcm.length / samplesPerBlock);
        const outBlocks: Buffer[] = [];

        const imaIndexTable = Int8Array.from([
            -1, -1, -1, -1, 2, 4, 6, 8,
            -1, -1, -1, -1, 2, 4, 6, 8,
        ]);

        const imaStepTable = Int16Array.from([
            7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
            19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
            50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
            130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
            337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
            876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
            2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
            5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
            15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
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
