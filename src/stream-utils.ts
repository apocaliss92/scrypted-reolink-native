import type {
    CompositeStreamPipOptions,
    ReolinkBaichuanApi,
    Rfc4571TcpServer,
    StreamProfile,
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
     * @param profile The stream profile (main, sub, ext) - used to determine if a new client is needed.
     */
    createStreamClient: (profile?: StreamProfile) => Promise<ReolinkBaichuanApi>;
    getLogger: () => Console;
    /**
     * Credentials to include in the TCP stream (username, password).
     * Uses the same credentials as the main connection.
     */
    credentials: {
        username: string;
        password: string;
    };
    /** If true, the stream client is shared with the main connection. Default: false. */
    sharedConnection?: boolean;
    /** Composite stream options for multifocal cameras */
    compositeOptions?: CompositeStreamPipOptions;
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

    const { host, port, sdp, audio, username, password } = await streamManager.getRfcStream(channel, profile, streamKey, expectedVideoType);

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

    const url = new URL(`tcp://${host}`);
    url.port = port.toString();
    if (username) {
        url.username = username;
    }
    if (password) {
        url.password = password;
    }

    const rfc = {
        url,
        sdp,
        mediaStreamOptions: mso as ResponseMediaStreamOptions,
    };

    return await sdk.mediaManager.createMediaObject(Buffer.from(JSON.stringify(rfc)), 'x-scrypted/x-rfc4571', {
        sourceId,
    });
}

export async function createRfc4571CompositeMediaObjectFromStreamManager(params: {
    streamManager: StreamManager;
    profile: StreamProfile;
    streamKey: string;
    expectedVideoType?: 'H264' | 'H265';
    selected: UrlMediaStreamOptions;
    sourceId: string;
    onDetectedCodec?: (detectedCodec: 'h264' | 'h265') => void;
}): Promise<MediaObject> {
    const { streamManager, profile, streamKey, expectedVideoType, selected, sourceId, onDetectedCodec } = params;

    const { host, port, sdp, audio, username, password } = await streamManager.getRfcCompositeStream(profile, streamKey, expectedVideoType);

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

    // Build URL with credentials: tcp://username:password@host:port
    const encodedUsername = encodeURIComponent(username || '');
    const encodedPassword = encodeURIComponent(password || '');
    const url = `tcp://${encodedUsername}:${encodedPassword}@${host}:${port}`;

    const rfc = {
        url,
        sdp,
        mediaStreamOptions: mso as ResponseMediaStreamOptions,
    };

    return await sdk.mediaManager.createMediaObject(Buffer.from(JSON.stringify(rfc)), 'x-scrypted/x-rfc4571', {
        sourceId,
    });
}

type RfcServerInfo = {
    host: string;
    port: number;
    sdp: string;
    audio?: { codec: string; sampleRate: number; channels: number };
    username: string;
    password: string;
};

export class StreamManager {
    private nativeRfcServers = new Map<string, Rfc4571TcpServer>();
    private nativeRfcServerCreatePromises = new Map<string, Promise<RfcServerInfo>>();

    constructor(private opts: StreamManagerOptions) {
    }

    private getLogger() {
        return this.opts.getLogger();
    }

    private async ensureRfcServer(
        streamKey: string,
        profile: StreamProfile,
        expectedVideoType: 'H264' | 'H265' | undefined,
        options: {
            channel?: number;
            compositeOptions?: CompositeStreamPipOptions;
        },
    ): Promise<RfcServerInfo> {
        const existingCreate = this.nativeRfcServerCreatePromises.get(streamKey);
        if (existingCreate) {
            return await existingCreate;
        }

        const createPromise = (async () => {
            const cached = this.nativeRfcServers.get(streamKey);
            if (cached?.server?.listening) {
                if (expectedVideoType && cached.videoType !== expectedVideoType) {
                    const kind = options.channel === undefined ? 'composite' : 'native';
                    this.getLogger().warn(
                        `Native RFC ${kind} cache codec mismatch for ${streamKey}: cached=${cached.videoType} expected=${expectedVideoType}; recreating server.`,
                    );
                }
                else {
                    return {
                        host: cached.host,
                        port: cached.port,
                        sdp: cached.sdp,
                        audio: cached.audio,
                        username: cached.username || this.opts.credentials.username,
                        password: cached.password || this.opts.credentials.password,
                    };
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

            const api = await this.opts.createStreamClient(profile);
            const { createRfc4571TcpServer } = await import('@apocaliss92/reolink-baichuan-js');

            // Use the same credentials as the main connection
            const { username, password } = this.opts.credentials;

            // If connection is shared, don't close it when stream teardown happens
            const closeApiOnTeardown = !(this.opts.sharedConnection ?? false);

            const created = await createRfc4571TcpServer({
                api,
                channel: options.channel,
                profile,
                logger: this.getLogger(),
                expectedVideoType: expectedVideoType as VideoType | undefined,
                closeApiOnTeardown,
                username,
                password,
                ...(options.compositeOptions ? { compositeOptions: options.compositeOptions } : {}),
            });

            this.nativeRfcServers.set(streamKey, created);
            created.server.once('close', () => {
                const current = this.nativeRfcServers.get(streamKey);
                if (current?.server === created.server) this.nativeRfcServers.delete(streamKey);
            });

            return {
                host: created.host,
                port: created.port,
                sdp: created.sdp,
                audio: created.audio,
                username: created.username || this.opts.credentials.username,
                password: created.password || this.opts.credentials.password,
            };
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
    ): Promise<RfcServerInfo> {
        return await this.ensureRfcServer(streamKey, profile, expectedVideoType, {
            channel,
        });
    }

    async getRfcCompositeStream(
        profile: StreamProfile,
        streamKey: string,
        expectedVideoType?: 'H264' | 'H265',
    ): Promise<RfcServerInfo> {
        return await this.ensureRfcServer(streamKey, profile, expectedVideoType, {
            channel: undefined, // Undefined channel indicates composite stream
            compositeOptions: this.opts.compositeOptions,
        });
    }

    /**
     * Close all active stream servers.
     * Useful when the main connection is reset and streams need to be recreated.
     */
    async closeAllStreams(reason?: string): Promise<void> {
        const servers = Array.from(this.nativeRfcServers.values());
        this.nativeRfcServers.clear();

        await Promise.allSettled(
            servers.map(async (server) => {
                try {
                    await server.close(reason || 'connection reset');
                } catch (e) {
                    this.getLogger().debug('Error closing stream server', e);
                }
            })
        );
    }
}
