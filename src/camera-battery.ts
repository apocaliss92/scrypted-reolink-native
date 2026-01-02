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

export class ReolinkNativeBatteryCamera extends CommonCameraMixin {
    private lastPicture: { mo: MediaObject; atMs: number } | undefined;
    private takePictureInFlight: Promise<MediaObject> | undefined;
    doorbellBinaryTimeout?: NodeJS.Timeout;
    motionDetected: boolean = false;
    motionTimeout: NodeJS.Timeout | undefined;

    constructor(nativeId: string, public plugin: ReolinkNativePlugin) {
        super(nativeId, plugin, {
            type: 'battery',
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

    async init(): Promise<void> {
    }

    async release(): Promise<void> {
        return this.resetBaichuanClient();
    }

    protected async withBaichuanClient<T>(fn: (api: ReolinkBaichuanApi) => Promise<T>): Promise<T> {
        const client = await this.ensureClient();
        return fn(client);
    }

    async createStreamClient(): Promise<ReolinkBaichuanApi> {
        const { ipAddress, username, password, uid } = this.storageSettings.values;
        if (!ipAddress || !username || !password) {
            throw new Error('Missing camera credentials');
        }
        const normalizedUid = normalizeUid(uid);
        if (!normalizedUid) throw new Error("UID is required for battery cameras (BCUDP)");

        const debugOptions = this.getBaichuanDebugOptions();
        const api = await createBaichuanApi(
            {
                host: ipAddress,
                username,
                password,
                uid: normalizedUid,
                logger: this.console,
                ...(debugOptions ? { debugOptions } : {}),
            },
            'udp',
        );
        await api.login();

        return api;
    }
}
