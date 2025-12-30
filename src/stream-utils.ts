import type {
    ReolinkBaichuanApi,
    StreamProfile,
    ScryptedRfc4571TcpServer,
    VideoType,
} from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };

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
    if (id === 'mainstream')
        return 'main';
    if (id === 'substream')
        return 'sub';
    if (id === 'extstream')
        return 'ext';

    return;
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
