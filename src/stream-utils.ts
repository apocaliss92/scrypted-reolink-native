import type {
    ReolinkBaichuanApi,
    StreamProfile,
    ScryptedRfc4571TcpServer,
    VideoType,
} from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };

import sdk, {
    type MediaObject,
    type RequestMediaStreamOptions,
    type ResponseMediaStreamOptions,
} from "@scrypted/sdk";

import type { UrlMediaStreamOptions } from "../../scrypted/plugins/rtsp/src/rtsp";

export interface StreamManagerOptions {
    /**
     * Creates a dedicated Baichuan session for streaming.
     * Required to support concurrent main+ext streams on firmwares where streamType overlaps.
     */
    createStreamClient: () => Promise<ReolinkBaichuanApi>;
    getLogger: () => Console;
}

export function parseStreamProfileFromId(id: string | undefined): StreamProfile | undefined {
    if (!id)
        return;

    // Handle native stream IDs: native_main, native_sub, native_ext
    if (id.startsWith('native_')) {
        const profile = id.replace('native_', '');
        return profile as StreamProfile;
    }

    // Handle RTMP IDs: main.bcs, sub.bcs, ext.bcs
    if (id.endsWith('.bcs')) {
        const profile = id.replace('.bcs', '');
        return profile as StreamProfile;
    }

    // Handle RTSP IDs: h264Preview_XX_main, h264Preview_XX_sub
    if (id.startsWith('h264Preview_')) {
        if (id.endsWith('_main'))
            return 'main';
        if (id.endsWith('_sub'))
            return 'sub';
    }

    return;
}

/**
 * Check if a stream ID represents a native Baichuan stream (prefixed with "native_")
 */
export function isNativeStreamId(id: string | undefined): boolean {
    return id?.startsWith('native_') ?? false;
}

export async function fetchVideoStreamOptionsFromApi(
    client: ReolinkBaichuanApi,
    channel: number,
    logger: Console,
): Promise<UrlMediaStreamOptions[]> {
    const streamMetadata = await client.getStreamMetadata(channel);

    const streams: UrlMediaStreamOptions[] = [];
    const list = streamMetadata?.streams || [];

    for (const stream of list) {
        const profile = stream.profile as StreamProfile;
        const codec = String(stream.videoEncType || '').includes('264')
            ? 'h264'
            : String(stream.videoEncType || '').includes('265')
                ? 'h265'
                : String(stream.videoEncType || '').toLowerCase();

        streams.push({
            name: `Native ${profile}`,
            id: `native_${profile}`,
            container: 'rtp',
            video: { codec, width: stream.width, height: stream.height },
            url: ``,
        });
    }

    return streams;
}

export async function buildVideoStreamOptionsFromRtspRtmp(
    client: ReolinkBaichuanApi,
    channel: number,
    ipAddress: string,
    username: string,
    password: string,
    cachedNetPort?: { rtsp?: { port?: number; enable?: number }; rtmp?: { port?: number; enable?: number } },
): Promise<UrlMediaStreamOptions[]> {
    const streams: UrlMediaStreamOptions[] = [];

    // Use cached net port if provided, otherwise fetch it
    const netPort = cachedNetPort || await client.getNetPort();
    const rtspEnabled = netPort.rtsp?.enable === 1;
    const rtmpEnabled = netPort.rtmp?.enable === 1;
    const rtspPort = netPort.rtsp?.port ?? 554;
    const rtmpPort = netPort.rtmp?.port ?? 1935;

    if (!rtspEnabled && !rtmpEnabled) {
        // If neither RTSP nor RTMP are enabled, return empty array
        return streams;
    }

    // Get stream metadata to build options
    const streamMetadata = await client.getStreamMetadata(channel);
    const list = streamMetadata?.streams || [];

    for (const stream of list) {
        const profile = stream.profile as StreamProfile;
        const codec = String(stream.videoEncType || '').includes('264')
            ? 'h264'
            : String(stream.videoEncType || '').includes('265')
                ? 'h265'
                : String(stream.videoEncType || '').toLowerCase();

        // Build RTSP URL if enabled (RTSP doesn't support ext stream, only main and sub)
        if (rtspEnabled && profile !== 'ext') {
            // RTSP format: rtsp://ip:port/h264Preview_XX_profile
            // XX is 1-based channel with 2-digit padding
            const channelStr = String(channel + 1).padStart(2, '0');
            const profileStr = profile === 'main' ? 'main' : 'sub';
            const rtspPath = `/h264Preview_${channelStr}_${profileStr}`;
            const rtspId = `h264Preview_${channelStr}_${profileStr}`;

            streams.push({
                name: `RTSP ${rtspId}`,
                id: rtspId,
                container: 'rtsp',
                video: { codec, width: stream.width, height: stream.height },
                url: `rtsp://${ipAddress}:${rtspPort}${rtspPath}`,
            });
        }

        // Build RTMP URL if enabled (RTMP supports main, sub, and ext streams)
        if (rtmpEnabled) {
            // RTMP format: /bcs/channelX_stream.bcs?channel=X&stream=stream_type&user=username&password=password
            // Based on reolink_aio api.py line 3295-3298:
            // - stream in path is "main", "sub", or "ext" (not "main.bcs")
            // - stream_type in query: 0 for main/ext, 1 for sub
            // - credentials: user and password as query parameters
            const streamName = profile === 'main' ? 'main' : profile === 'sub' ? 'sub' : 'ext';
            const streamType = profile === 'sub' ? 1 : 0; // 0 for main/ext, 1 for sub
            const rtmpId = `${streamName}.bcs`; // ID for Scrypted (main.bcs, sub.bcs, ext.bcs)

            // Use channel directly (0-based) in path, matching reolink_aio behavior
            const rtmpPath = `/bcs/channel${channel}_${streamName}.bcs`;
            const rtmpUrl = new URL(`rtmp://${ipAddress}:${rtmpPort}${rtmpPath}`);
            const params = rtmpUrl.searchParams;
            params.set('channel', channel.toString());
            params.set('stream', streamType.toString());
            // Credentials will be added by addRtspCredentials as user/password query params

            streams.push({
                name: `RTMP ${rtmpId}`,
                id: rtmpId,
                container: 'rtmp',
                video: { codec, width: stream.width, height: stream.height },
                url: rtmpUrl.toString(),
            });
        }
    }

    // Sort streams: RTMP first, then RTSP
    streams.sort((a, b) => {
        if (a.container === 'rtmp' && b.container !== 'rtmp') return -1;
        if (a.container !== 'rtmp' && b.container === 'rtmp') return 1;
        return 0;
    });

    return streams;
}

export function selectStreamOption(
    vsos: UrlMediaStreamOptions[] | undefined,
    request: RequestMediaStreamOptions,
): UrlMediaStreamOptions {
    if (!request) throw new Error('video streams not set up or no longer exists.');
    const selected = vsos?.find((s) => s.id === request.id) || vsos?.[0];
    if (!selected) throw new Error('No stream options available');
    return selected;
}

export function expectedVideoTypeFromUrlMediaStreamOptions(selected: UrlMediaStreamOptions): 'H264' | 'H265' | undefined {
    const codec = selected?.video?.codec;
    if (typeof codec !== 'string') return undefined;
    if (codec.includes('265')) return 'H265';
    if (codec.includes('264')) return 'H264';
    return undefined;
}

export async function createRfc4571MediaObjectFromStreamManager(params: {
    streamManager: StreamManager;
    channel: number;
    profile: StreamProfile;
    streamKey: string;
    expectedVideoType?: 'H264' | 'H265';
    selected: UrlMediaStreamOptions;
    sourceId: string;
    onDetectedCodec?: (detectedCodec: 'h264' | 'h265') => void;
}): Promise<MediaObject> {
    const { streamManager, channel, profile, streamKey, expectedVideoType, selected, sourceId, onDetectedCodec } = params;

    const { host, port, sdp, audio } = await streamManager.getRfcStream(channel, profile, streamKey, expectedVideoType);

    // Update cached stream options with the detected codec (helps prebuffer/NVR avoid mismatch).
    try {
        const detected = /a=rtpmap:\d+\s+(H26[45])\//.exec(sdp)?.[1];
        if (detected) {
            const dc = detected === 'H265' ? 'h265' : 'h264';
            onDetectedCodec?.(dc);
        }
    }
    catch {
        // ignore
    }

    const { url: _ignoredUrl, ...mso }: any = selected;
    mso.container = 'rtp';
    if (audio) {
        mso.audio ||= {};
        mso.audio.codec = audio.codec;
        mso.audio.sampleRate = audio.sampleRate;
        mso.audio.channels = audio.channels;
    }

    const rfc = {
        url: `tcp://${host}:${port}`,
        sdp,
        mediaStreamOptions: mso as ResponseMediaStreamOptions,
    };

    return await sdk.mediaManager.createMediaObject(Buffer.from(JSON.stringify(rfc)), 'x-scrypted/x-rfc4571', {
        sourceId,
    });
}

export class StreamManager {
    private nativeRfcServers = new Map<string, ScryptedRfc4571TcpServer>();
    private nativeRfcServerCreatePromises = new Map<string, Promise<{ host: string; port: number; sdp: string; audio?: { codec: string; sampleRate: number; channels: number } }>>();

    constructor(private opts: StreamManagerOptions) {
    }

    private getLogger() {
        return this.opts.getLogger();
    }

    private async ensureNativeRfcServer(
        streamKey: string,
        channel: number,
        profile: StreamProfile,
        expectedVideoType?: 'H264' | 'H265',
    ): Promise<{ host: string; port: number; sdp: string; audio?: { codec: string; sampleRate: number; channels: number } }> {
        const existingCreate = this.nativeRfcServerCreatePromises.get(streamKey);
        if (existingCreate) {
            return await existingCreate;
        }

        const createPromise = (async () => {
            const cached = this.nativeRfcServers.get(streamKey);
            if (cached?.server?.listening) {
                if (expectedVideoType && cached.videoType !== expectedVideoType) {
                    this.getLogger().warn(
                        `Native RFC cache codec mismatch for ${streamKey}: cached=${cached.videoType} expected=${expectedVideoType}; recreating server.`,
                    );
                }
                else {
                    return { host: cached.host, port: cached.port, sdp: cached.sdp, audio: cached.audio };
                }
            }

            if (cached) {
                try {
                    await cached.close('recreate');
                }
                catch {
                    // ignore
                }
                this.nativeRfcServers.delete(streamKey);
            }

            const api = await this.opts.createStreamClient();
            const { createScryptedRfc4571TcpServer } = await import('@apocaliss92/reolink-baichuan-js');
            const created = await createScryptedRfc4571TcpServer({
                api,
                channel,
                profile,
                logger: this.getLogger(),
                expectedVideoType: expectedVideoType as VideoType | undefined,
                closeApiOnTeardown: true,
            });

            this.nativeRfcServers.set(streamKey, created);
            created.server.once('close', () => {
                const current = this.nativeRfcServers.get(streamKey);
                if (current?.server === created.server) this.nativeRfcServers.delete(streamKey);
            });

            return { host: created.host, port: created.port, sdp: created.sdp, audio: created.audio };
        })();

        this.nativeRfcServerCreatePromises.set(streamKey, createPromise);
        try {
            return await createPromise;
        }
        finally {
            this.nativeRfcServerCreatePromises.delete(streamKey);
        }
    }

    async getRfcStream(
        channel: number,
        profile: StreamProfile,
        streamKey: string,
        expectedVideoType?: 'H264' | 'H265',
    ): Promise<{ host: string; port: number; sdp: string; audio?: { codec: string; sampleRate: number; channels: number } }> {
        return await this.ensureNativeRfcServer(streamKey, channel, profile, expectedVideoType);
    }
}
