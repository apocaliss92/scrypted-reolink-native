import type {
    CompositeStreamPipOptions,
    NativeVideoStreamVariant,
    ReolinkBaichuanApi,
    Rfc4571TcpServer,
    StreamProfile,
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
     * @param streamKey The unique stream key (e.g., "composite_default_main", "channel_0_main", etc.)
     *                  Contains all necessary information (profile, variantType, channel) for stream identification.
     */
    createStreamClient: (streamKey: string) => Promise<ReolinkBaichuanApi>;
    logger: Console;
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

    // Handle plain profiles (used by composite parsing: 'main'/'sub'/'ext')
    if (id === 'main' || id === 'sub' || id === 'ext') {
        return id as StreamProfile;
    }

    // Handle native stream IDs: native_main, native_sub, native_ext, native_autotrack_main, native_autotrack_sub, etc.
    if (id.startsWith('native_')) {
        const withoutPrefix = id.replace('native_', '');
        // Extract profile from formats like "main", "sub", "ext", "autotrack_main", "telephoto_sub", etc.
        // The profile is always the last part after underscore or the whole string if no underscore
        const parts = withoutPrefix.split('_');
        const profile = parts[parts.length - 1]; // Take the last part as profile
        if (profile === 'main' || profile === 'sub' || profile === 'ext') {
            return profile as StreamProfile;
        }
        // If no valid profile found, try to match the whole string
        if (withoutPrefix === 'main' || withoutPrefix === 'sub' || withoutPrefix === 'ext') {
            return withoutPrefix as StreamProfile;
        }
        return undefined;
    }

    // Handle RTMP IDs: main.bcs, sub.bcs, ext.bcs
    if (id.endsWith('.bcs')) {
        const profile = id.replace('.bcs', '');
        if (profile === 'main' || profile === 'sub' || profile === 'ext') {
            return profile as StreamProfile;
        }
        return undefined;
    }

    // Handle RTSP IDs: h264Preview_XX_main, h264Preview_XX_sub, Preview_03_autotrack, etc.
    if (id.startsWith('h264Preview_')) {
        if (id.endsWith('_main'))
            return 'main';
        if (id.endsWith('_sub'))
            return 'sub';
    }

    // Handle RTSP IDs like Preview_03_autotrack, Preview_03_autotrack_sub
    // These should map to main or sub based on the suffix
    if (id.includes('Preview_')) {
        if (id.endsWith('_autotrack_sub') || id.endsWith('_sub')) {
            return 'sub';
        }
        if (id.endsWith('_autotrack') || id.endsWith('_main') || id.match(/Preview_\d+_?[a-z]*$/)) {
            return 'main';
        }
    }

    return;
}

/**
 * Extract and normalize variant type from stream ID or URL (e.g., "autotrack" from "native_autotrack_main" or "?variant=autotrack")
 * Returns undefined if no variant is present, or "autotrack"/"telephoto" if present
 * Note: on Hub/NVR multifocal firmwares, the tele lens is often requested via "telephoto".
 */
export function extractVariantFromStreamId(id: string | undefined, url?: string | undefined): 'autotrack' | 'telephoto' | undefined {
    let variant: string | undefined;

    // First try to extract from ID
    if (id) {
        // Handle native stream IDs: native_autotrack_main, native_telephoto_sub, etc.
        if (id.startsWith('native_')) {
            const withoutPrefix = id.replace('native_', '');
            const parts = withoutPrefix.split('_');
            // If there are more than 1 parts, the first part(s) before the profile is the variant
            // e.g., "autotrack_main" -> variant: "autotrack", profile: "main"
            if (parts.length > 1) {
                const profile = parts[parts.length - 1];
                // Only return variant if profile is valid (main/sub/ext)
                if (profile === 'main' || profile === 'sub' || profile === 'ext') {
                    // Join all parts except the last one as variant (handles multi-part variants)
                    variant = parts.slice(0, -1).join('_');
                }
            }
        }

        // Handle RTSP IDs like Preview_03_autotrack, Preview_03_autotrack_sub
        if (!variant && id.includes('Preview_')) {
            if (id.includes('_autotrack')) {
                variant = 'autotrack';
            } else if (id.includes('_telephoto')) {
                variant = 'telephoto';
            }
        }
    }

    // Fallback: try to extract from URL query parameter
    if (!variant && url) {
        try {
            const urlObj = new URL(url);
            const variantParam = urlObj.searchParams.get('variant');
            if (variantParam) {
                variant = variantParam;
            }
        } catch {
            // Invalid URL, ignore
        }
    }

    // Normalize variant: accept "autotrack", "telephoto", or map "default" to undefined
    if (variant === 'autotrack' || variant === 'telephoto') {
        // Preserve explicit variants; firmware-specific behavior is handled by the library.
        return variant as 'autotrack' | 'telephoto';
    }

    return undefined;
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

export async function createRfc4571MediaObjectFromStreamManager(params: {
    streamManager: StreamManager;
    channel: number;
    profile: StreamProfile;
    streamKey: string;
    variant?: NativeVideoStreamVariant;
    selected: UrlMediaStreamOptions;
    sourceId: string;
}): Promise<MediaObject> {
    const { streamManager, channel, profile, streamKey, variant, selected, sourceId } = params;

    const { host, port, sdp, audio, username, password } = await streamManager.getRfcStream(channel, profile, streamKey, variant);

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
    selected: UrlMediaStreamOptions;
    sourceId: string;
    variantType?: NativeVideoStreamVariant;
}): Promise<MediaObject> {
    const { streamManager, profile, streamKey, selected, sourceId, variantType } = params;

    // Extract variantType from streamKey if not provided (format: composite_${variantType}_${profile})
    let extractedVariantType = variantType;
    if (!extractedVariantType && streamKey.startsWith('composite_')) {
        const parts = streamKey.split('_');
        if (parts.length >= 3) {
            // Format: composite_${variantType}_${profile}
            const variantPart = parts[1];
            if (variantPart === 'default' || variantPart === 'autotrack' || variantPart === 'telephoto') {
                extractedVariantType = variantPart as NativeVideoStreamVariant;
            }
        }
    }

    const { host, port, sdp, audio, username, password } = await streamManager.getRfcCompositeStream(profile, streamKey, extractedVariantType);

    const { url: _ignoredUrl, ...mso }: any = selected;
    mso.container = 'rtp';
    if (audio) {
        mso.audio ||= {};
        mso.audio.codec = audio.codec;
        mso.audio.sampleRate = audio.sampleRate;
        mso.audio.channels = audio.channels;
    }

    // Build URL with credentials: tcp://username:password@host:port
    // Keep this consistent with non-composite path (URL object -> JSON string via toJSON()).
    const urlObj = new URL(`tcp://${host}`);
    urlObj.port = port.toString();
    if (username) {
        urlObj.username = username;
    }
    if (password) {
        urlObj.password = password;
    }

    const rfc = {
        url: urlObj,
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
        // Ensure logger is always valid
        if (!this.opts.logger) {
            this.opts.logger = console;
        }
    }

    private getLogger(): Console {
        return this.opts.logger || console;
    }

    private async ensureRfcServer(
        streamKey: string,
        profile: StreamProfile,
        options: {
            channel?: number;
            variant?: NativeVideoStreamVariant;
            compositeOptions?: CompositeStreamPipOptions;
        },
    ): Promise<RfcServerInfo> {
        // Check for existing promise first to prevent duplicate server creation
        const existingCreate = this.nativeRfcServerCreatePromises.get(streamKey);
        if (existingCreate) {
            return await existingCreate;
        }

        // Double-check: if server already exists and is listening, return it immediately
        const existingServer = this.nativeRfcServers.get(streamKey);
        if (existingServer?.server?.listening) {
            this.getLogger().log(`Reusing existing RFC4571 server for streamKey=${streamKey} (port=${existingServer.port})`);
            return {
                host: existingServer.host,
                port: existingServer.port,
                sdp: existingServer.sdp,
                audio: existingServer.audio,
                username: existingServer.username || this.opts.credentials.username,
                password: existingServer.password || this.opts.credentials.password,
            };
        }

        const createPromise = (async () => {
            const cached = this.nativeRfcServers.get(streamKey);
            if (cached?.server?.listening) {
                return {
                    host: cached.host,
                    port: cached.port,
                    sdp: cached.sdp,
                    audio: cached.audio,
                    username: cached.username || this.opts.credentials.username,
                    password: cached.password || this.opts.credentials.password,
                };
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

            const isComposite = options.channel === undefined;

            // For composite streams, MUST use two distinct Baichuan sessions (widerApi and teleApi).
            // Otherwise cmd_id=3 frames can mix when streamType overlaps (wide/tele alternation/corruption).
            // Each stream needs its own dedicated socket to avoid frame mixing.
            // Create separate streamKeys for wider and tele to ensure distinct sockets:
            // Format: composite_${variantType}_${profile}_wider and composite_${variantType}_${profile}_tele
            const compositeApis = isComposite
                ? {
                    widerApi: await this.opts.createStreamClient(`${streamKey}_wider`),
                    teleApi: await this.opts.createStreamClient(`${streamKey}_tele`),
                }
                : undefined;

            // For non-composite streams, create a single API client
            // For composite streams, api is still required as baseApi but widerApi and teleApi are used instead
            // Pass streamKey to createStreamClient - it contains all necessary information (profile, variantType, channel)
            // For composite streams, streamKey format: composite_${variantType}_${profile}
            // For regular streams, streamKey format: channel_${channel}_${profile}_${variantType} or similar
            const api = isComposite
                ? compositeApis.widerApi // For composite, use widerApi as baseApi (it will be overridden by compositeApis)
                : await this.opts.createStreamClient(streamKey);

            const { createRfc4571TcpServer } = await import('@apocaliss92/reolink-baichuan-js');

            const { username, password } = this.opts.credentials;

            // If connection is shared, don't close it when stream teardown happens
            // For composite, we create dedicated APIs even if the device uses a shared main connection.
            // Ensure they are closed on teardown.
            const closeApiOnTeardown = isComposite ? true : !(this.opts.sharedConnection ?? false);

            let created: any;
            try {
                created = await createRfc4571TcpServer({
                    api,
                    channel: options.channel,
                    profile,
                    variant: options.variant,
                    logger: this.getLogger(),
                    closeApiOnTeardown,
                    username,
                    password,
                    // Composite can take a bit longer (ffmpeg warmup + first IDR).
                    ...(isComposite ? { keyframeTimeoutMs: 20_000, idleTeardownMs: 20_000 } : {}),
                    ...(options.compositeOptions ? { compositeOptions: options.compositeOptions } : {}),
                    ...(compositeApis ? { compositeApis } : {}),
                });
            }
            catch (e) {
                if (isComposite && closeApiOnTeardown && compositeApis) {
                    await Promise.allSettled([
                        compositeApis.widerApi?.close?.(),
                        compositeApis.teleApi?.close?.(),
                    ]);
                }
                throw e;
            }

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
        variant?: NativeVideoStreamVariant,
    ): Promise<RfcServerInfo> {
        return await this.ensureRfcServer(streamKey, profile, {
            channel,
            variant,
        });
    }

    async getRfcCompositeStream(
        profile: StreamProfile,
        streamKey: string,
        variantType?: NativeVideoStreamVariant,
    ): Promise<RfcServerInfo> {
        // Extract variantType from streamKey if not provided (format: composite_${variantType}_${profile})
        let extractedVariantType = variantType;
        if (!extractedVariantType && streamKey.startsWith('composite_')) {
            const parts = streamKey.split('_');
            if (parts.length >= 3) {
                // Format: composite_${variantType}_${profile}
                const variantPart = parts[1];
                if (variantPart === 'default' || variantPart === 'autotrack' || variantPart === 'telephoto') {
                    extractedVariantType = variantPart as NativeVideoStreamVariant;
                }
            }
        }
        
        // Pass variantType to ensureRfcServer so it can be used when creating the stream client
        // This ensures each variantType gets its own socket
        return await this.ensureRfcServer(streamKey, profile, {
            channel: undefined, // Undefined channel indicates composite stream
            variant: extractedVariantType,
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
                    this.getLogger().debug('Error closing stream server', e?.message || String(e));
                }
            })
        );
    }
}
