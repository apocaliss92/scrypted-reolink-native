import type { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, {
    type MediaObject,
    RequestPictureOptions,
    ResponsePictureOptions
} from "@scrypted/sdk";
import {
    CommonCameraMixin,
} from "./common";
import { createBaichuanApi, normalizeUid } from "./connect";
import type ReolinkNativePlugin from "./main";


export type BatteryCameraHints = {
    explicitBatteryCam: boolean;
    hasBatteryCapability: boolean;
    hasUid: boolean;
};

export function isBatteryCamHinted(hints: BatteryCameraHints): boolean {
    return hints.explicitBatteryCam || hints.hasBatteryCapability || hints.hasUid;
}

export function assertBatteryUidPresent(hints: BatteryCameraHints): void {
    if (!isBatteryCamHinted(hints)) return;
    if (!hints.hasUid) {
        throw new Error("UID is required for battery cameras (BCUDP)");
    }
}

export async function refreshBatteryAndPirWhileAwake(options: {
    api: ReolinkBaichuanApi;
    channel: number;
    hasPirEvents: boolean;
    processBatteryData: (data: any) => Promise<void>;
    setPirEnabled?: (enabled: boolean) => void;
}): Promise<void> {
    const { api, channel, hasPirEvents, processBatteryData, setPirEnabled } = options;

    try {
        const battery = await api.getBatteryStatus(channel);
        await processBatteryData(battery);
    } catch {
        // ignore
    }

    try {
        if (hasPirEvents) {
            const pir = await api.getPirInfo(channel);
            setPirEnabled?.(!!pir.enabled);
        }
    } catch {
        // ignore
    }
}

export class ReolinkNativeBatteryCamera extends CommonCameraMixin {
    private lastPicture: { mo: MediaObject; atMs: number } | undefined;
    private takePictureInFlight: Promise<MediaObject> | undefined;
    /**
     * IMPORTANT for BCUDP stability:
     * Battery cams can disconnect the active UDP stream if we establish a second concurrent BCUDP session.
     * Reuse the same logged-in UDP client for streaming + snapshots/ops while streaming.
     */
    private streamBaichuanApi: ReolinkBaichuanApi | undefined;
    private streamBaichuanApiLoginPromise: Promise<ReolinkBaichuanApi> | undefined;
    doorbellBinaryTimeout?: NodeJS.Timeout;
    motionDetected: boolean = false;
    motionTimeout: NodeJS.Timeout | undefined;

    /**
     * When we're NOT streaming, background tasks (snapshots, prebuffer, option refresh) can fire concurrently.
     * Creating multiple BCUDP sessions in parallel makes the camera rotate did/cid and breaks login/streaming.
     * Keep one shared "idle" session with refcount + delayed close to prevent session storms.
     */
    private idleBaichuanApi: ReolinkBaichuanApi | undefined;
    private idleBaichuanApiLoginPromise: Promise<ReolinkBaichuanApi> | undefined;
    private idleBaichuanApiRefCount = 0;
    private idleBaichuanApiCloseTimer: NodeJS.Timeout | undefined;

    constructor(nativeId: string, public plugin: ReolinkNativePlugin) {
        super(nativeId, plugin, {
            protocol: 'udp',
            includeUid: true,
            includeMixinsSetup: true,
            additionalSettings: {
                snapshotCacheMinutes: {
                    title: "Snapshot Cache Minutes",
                    group: 'Advanced',
                    description: "Return a cached snapshot if taken within the last N minutes.",
                    type: "number",
                    defaultValue: 5,
                },
            },
        });
    }

    async takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        const { snapshotCacheMinutes = 5 } = this.storageSettings.values;
        const cacheMs = snapshotCacheMinutes * 60_000;
        if (cacheMs > 0 && this.lastPicture && Date.now() - this.lastPicture.atMs < cacheMs) {
            this.console.log(`Returning cached snapshot, taken at ${new Date(this.lastPicture.atMs).toLocaleString()}`);
            return this.lastPicture.mo;
        }

        if (this.takePictureInFlight) {
            return await this.takePictureInFlight;
        }

        this.console.log('Taking new snapshot from camera');
        this.takePictureInFlight = (async () => {
            const channel = this.getRtspChannel();
            const snapshotBuffer = await this.withBaichuanClient(async (api) => {
                return await api.getSnapshot(channel);
            });
            const mo = await sdk.mediaManager.createMediaObject(snapshotBuffer, 'image/jpeg');
            this.lastPicture = { mo, atMs: Date.now() };
            this.console.log(`Snapshot taken at ${new Date(this.lastPicture.atMs).toLocaleString()}`);
            return mo;
        })();

        try {
            return await this.takePictureInFlight;
        }
        finally {
            this.takePictureInFlight = undefined;
        }
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [];
    }

    async ensureClient(): Promise<ReolinkBaichuanApi> {
        return await this.withBaichuanClient(async (api) => api);
    }

    async init(): Promise<void> {
    }

    async release(): Promise<void> {
        // Tear down any cached BCUDP session.
        try {
            await this.streamBaichuanApi?.close();
        }
        catch {
            // ignore
        }
        this.streamBaichuanApi = undefined;

        try {
            if (this.idleBaichuanApiCloseTimer) clearTimeout(this.idleBaichuanApiCloseTimer);
        }
        catch {
            // ignore
        }
        this.idleBaichuanApiCloseTimer = undefined;
        this.idleBaichuanApiRefCount = 0;
        this.idleBaichuanApiLoginPromise = undefined;

        try {
            await this.idleBaichuanApi?.close();
        }
        catch {
            // ignore
        }
        this.idleBaichuanApi = undefined;
    }

    private async acquireIdleBaichuanApi(): Promise<ReolinkBaichuanApi> {
        // Cancel any pending close (we're about to reuse it).
        if (this.idleBaichuanApiCloseTimer) {
            clearTimeout(this.idleBaichuanApiCloseTimer);
            this.idleBaichuanApiCloseTimer = undefined;
        }

        if (this.idleBaichuanApi) {
            this.idleBaichuanApiRefCount++;
            return this.idleBaichuanApi;
        }
        if (this.idleBaichuanApiLoginPromise) {
            const api = await this.idleBaichuanApiLoginPromise;
            this.idleBaichuanApiRefCount++;
            return api;
        }

        const { ipAddress, username, password, uid } = this.storageSettings.values;
        if (!ipAddress || !username || !password) throw new Error("Missing camera credentials");
        const normalizedUid = normalizeUid(uid);
        if (!normalizedUid) throw new Error("UID is required for battery cameras (BCUDP)");

        this.idleBaichuanApiLoginPromise = (async () => {
            const api = await createBaichuanApi(
                {
                    host: ipAddress,
                    username,
                    password,
                    uid: normalizedUid,
                    logger: this.console,
                },
                "udp",
            );
            await api.login();
            this.idleBaichuanApi = api;
            return api;
        })();

        try {
            const api = await this.idleBaichuanApiLoginPromise;
            this.idleBaichuanApiRefCount++;
            return api;
        }
        finally {
            this.idleBaichuanApiLoginPromise = undefined;
        }
    }

    private releaseIdleBaichuanApi(api: ReolinkBaichuanApi): void {
        if (this.idleBaichuanApi !== api) return;
        this.idleBaichuanApiRefCount = Math.max(0, this.idleBaichuanApiRefCount - 1);
        if (this.idleBaichuanApiRefCount > 0) return;

        // Delay close slightly: snapshot + prebuffer often happen back-to-back.
        if (this.idleBaichuanApiCloseTimer) clearTimeout(this.idleBaichuanApiCloseTimer);
        this.idleBaichuanApiCloseTimer = setTimeout(() => {
            const toClose = this.idleBaichuanApi;
            this.idleBaichuanApi = undefined;
            this.idleBaichuanApiCloseTimer = undefined;
            if (!toClose) return;
            toClose.close().catch(() => { });
        }, 2500);
    }


    protected async withBaichuanClient<T>(fn: (api: ReolinkBaichuanApi) => Promise<T>): Promise<T> {
        // If a streaming BCUDP session is active, reuse it.
        // Creating a second BCUDP session (even briefly for snapshots) can trigger the camera to
        // disconnect the stream (observed as D2C_DISC in packet captures).
        if (this.streamBaichuanApi) {
            return await fn(this.streamBaichuanApi);
        }
        // If the streaming session is in the middle of logging in, wait and reuse it.
        // This prevents a race at stream startup where a concurrent snapshot/metadata call
        // would otherwise create a second BCUDP session, causing the camera to disconnect.
        if (this.streamBaichuanApiLoginPromise) {
            const api = await this.streamBaichuanApiLoginPromise;
            return await fn(api);
        }

        // Not streaming: use a shared idle BCUDP session to avoid concurrent session storms.
        const api = await this.acquireIdleBaichuanApi();
        try {
            return await fn(api);
        }
        finally {
            this.releaseIdleBaichuanApi(api);
        }
    }

    async createStreamClient(): Promise<ReolinkBaichuanApi> {
        if (this.streamBaichuanApi) {
            return this.streamBaichuanApi;
        }
        if (this.streamBaichuanApiLoginPromise) {
            return await this.streamBaichuanApiLoginPromise;
        }

        const { ipAddress, username, password, uid } = this.storageSettings.values;
        if (!ipAddress || !username || !password) throw new Error("Missing camera credentials");
        const normalizedUid = normalizeUid(uid);
        if (!normalizedUid) throw new Error("UID is required for battery cameras (BCUDP)");

        this.streamBaichuanApiLoginPromise = (async () => {
            const api = await createBaichuanApi(
                {
                    host: ipAddress,
                    username,
                    password,
                    uid: normalizedUid,
                    logger: this.console,
                },
                "udp",
            );
            await api.login();

            // Clear cache on transport close so we can reconnect on next request.
            try {
                api.client.once("close", () => {
                    if (this.streamBaichuanApi === api) {
                        this.streamBaichuanApi = undefined;
                    }
                });
            }
            catch {
                // ignore
            }

            this.streamBaichuanApi = api;
            return api;
        })();

        try {
            return await this.streamBaichuanApiLoginPromise;
        }
        finally {
            this.streamBaichuanApiLoginPromise = undefined;
        }
    }



}
