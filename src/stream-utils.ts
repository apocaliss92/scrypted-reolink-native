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
    * @param streamKey The unique stream key (e.g., "composite-rtsp-default-sub-sub", "channel_0_main", etc.)
    *                  Forwarded to the library as `requestedId`.
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

type ReolinkRfc4571Metadata = {
    profile: StreamProfile;
    channel?: number;
    variant?: NativeVideoStreamVariant;
    /** Explicitly mark composite (channel-less) streams. If omitted, `channel===undefined` implies composite. */
    isComposite?: boolean;
};

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
    streamKey: string;
    selected: UrlMediaStreamOptions;
    sourceId: string;
}): Promise<MediaObject> {
    const { streamManager, streamKey, selected, sourceId } = params;

    const meta = (selected as any)?.reolinkRfc4571 as ReolinkRfc4571Metadata | undefined;
    if (!meta?.profile) {
        throw new Error(`Missing RFC4571 metadata/profile for streamKey='${streamKey}'`);
    }

    const { host, port, sdp, audio, username, password } = await streamManager.getRfcServer(streamKey, meta);

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

    /**
     * Unified RFC4571 server accessor.
     *
     * `stream-utils` does not parse `streamKey`. It forwards the `streamKey` as `requestedId`
     * and relies on explicit metadata from the selected stream option (profile/channel/variant).
     */
    async getRfcServer(streamKey: string, meta: ReolinkRfc4571Metadata): Promise<RfcServerInfo> {
        if (!meta?.profile) {
            throw new Error(`getRfcServer: missing profile for streamKey='${streamKey}'`);
        }

        const isComposite = meta.isComposite ?? (meta.channel === undefined);

        return await this.ensureRfcServer(streamKey, meta.profile, {
            channel: isComposite ? undefined : meta.channel,
            variant: meta.variant,
            compositeOptions: isComposite ? this.opts.compositeOptions : undefined,
        });
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

            // IMPORTANT: do not parse composite profiles here.
            // The library/server derives the composite pairing from the requested id.

            // For composite streams, we may want two distinct Baichuan sessions (wider + tele)
            // to avoid frame mixing on some firmwares. On BCUDP/battery devices, extra sessions
            // can be harmful; in that case, createStreamClient may return the same underlying client.
            //
            // Use stable per-request keys; include variant for tele to keep sessions distinct.
            const compositeWiderStreamKey = `${streamKey}_wider`;
            const compositeTeleStreamKey = `${streamKey}_tele_${options.variant ?? 'default'}`;

            // For composite streams, using two distinct Baichuan sessions can avoid frame mixing on some firmwares.
            // However, for UDP/battery devices extra BCUDP sessions can trigger storms; if we detect the same
            // underlying client, fall back to single-session composite.
            let compositeApis:
                | {
                    widerApi: ReolinkBaichuanApi;
                    teleApi: ReolinkBaichuanApi;
                }
                | undefined;
            if (isComposite) {
                try {
                    const widerApi = await this.opts.createStreamClient(compositeWiderStreamKey);
                    const teleApi = await this.opts.createStreamClient(compositeTeleStreamKey);

                    const sameApiObject = widerApi === teleApi;
                    const sameUnderlyingClient = (widerApi as any)?.client && (teleApi as any)?.client
                        ? (widerApi as any).client === (teleApi as any).client
                        : false;

                    if (!sameApiObject && !sameUnderlyingClient) {
                        compositeApis = { widerApi, teleApi };
                    } else {
                        // Likely a shared/battery connection: avoid forcing multi-session behavior.
                        compositeApis = undefined;
                    }
                } catch {
                    // Best-effort: if creating dedicated sessions fails, fall back to single-session composite.
                    compositeApis = undefined;
                }
            }

            // For non-composite streams, create/reuse a single API client.
            // For NVR/Hub (sharedConnection=true), avoid creating one TCP session per profile
            // (e.g. main+sub would otherwise become two sockets). Group by (channel, variant).
            // For composite streams, base api must be a real lens streamKey (not the composite RFC key).
            const shared = this.opts.sharedConnection ?? false;
            const nonCompositeApiKey = (!isComposite && shared && options.channel !== undefined)
                ? `channel_${options.channel}_${options.variant ?? 'default'}`
                : streamKey;

            const api = isComposite
                ? (compositeApis?.widerApi ?? await this.opts.createStreamClient(compositeWiderStreamKey))
                : await this.opts.createStreamClient(nonCompositeApiKey);

            const { createRfc4571TcpServer } = await import('@apocaliss92/reolink-baichuan-js');

            const { username, password } = this.opts.credentials;

            // If connection is shared, don't close it when stream teardown happens
            // For composite, we create dedicated APIs even if the device uses a shared main connection.
            // On battery/BCUDP (sharedConnection=true), prefer keeping them alive to avoid reconnect storms.
            const closeApiOnTeardown = isComposite
                ? (Boolean(compositeApis) && !(this.opts.sharedConnection ?? false))
                : !(this.opts.sharedConnection ?? false);

            let created: any;
            try {
                const compositeOptions = isComposite ? options.compositeOptions : undefined;

                created = await createRfc4571TcpServer({
                    api,
                    channel: options.channel,
                    profile,
                    variant: options.variant,
                    logger: this.getLogger(),
                    closeApiOnTeardown,
                    username,
                    password,
                    requestedId: streamKey,
                    // Composite can take a bit longer (ffmpeg warmup + first IDR).
                    ...(isComposite ? { keyframeTimeoutMs: 20_000, idleTeardownMs: 20_000 } : {}),
                    ...(compositeOptions ? { compositeOptions } : {}),
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
        // Back-compat wrapper. Prefer getRfcServer(streamKey).
        return await this.ensureRfcServer(streamKey, profile, { channel, variant });
    }

    async getRfcCompositeStream(
        profile: StreamProfile,
        streamKey: string,
        variantType?: NativeVideoStreamVariant,
    ): Promise<RfcServerInfo> {
        // Back-compat wrapper. Prefer getRfcServer(streamKey).
        // Pass variantType to ensureRfcServer so it can be used when creating the stream client.
        return await this.ensureRfcServer(streamKey, profile, {
            channel: undefined,
            variant: variantType,
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
