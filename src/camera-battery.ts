import type { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, {
    Device,
    DeviceProvider,
    Brightness,
    type MediaObject,
    OnOff,
    type RequestMediaStreamOptions,
    type ResponseMediaStreamOptions,
    ScryptedDeviceBase,
    ScryptedInterface,
    ScryptedDeviceType,
    type Setting,
    type Settings,
    type VideoCamera,
    Camera,
    RequestPictureOptions,
    ResponsePictureOptions,
} from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import type { UrlMediaStreamOptions } from "../../scrypted/plugins/rtsp/src/rtsp";
import type ReolinkNativePlugin from "./main";
import { createBaichuanApi, normalizeUid } from "./connect";
import {
    createRfc4571MediaObjectFromStreamManager,
    expectedVideoTypeFromUrlMediaStreamOptions,
    fetchVideoStreamOptionsFromApi,
    parseStreamProfileFromId,
    selectStreamOption,
    StreamManager,
} from "./stream-utils";

class ReolinkBatteryPirSensor extends ScryptedDeviceBase implements OnOff {
    constructor(public camera: ReolinkNativeBatteryCamera, nativeId: string) {
        super(nativeId);
    }

    async turnOff(): Promise<void> {
        this.on = false;
        await this.camera.setPirEnabled(false);
    }

    async turnOn(): Promise<void> {
        this.on = true;
        await this.camera.setPirEnabled(true);
    }
}

class ReolinkBatterySiren extends ScryptedDeviceBase implements OnOff {
    constructor(public camera: ReolinkNativeBatteryCamera, nativeId: string) {
        super(nativeId);
    }

    async turnOff(): Promise<void> {
        this.on = false;
        await this.camera.setSirenEnabled(false);
    }

    async turnOn(): Promise<void> {
        this.on = true;
        await this.camera.setSirenEnabled(true);
    }
}

class ReolinkBatteryFloodlight extends ScryptedDeviceBase implements OnOff, Brightness {
    constructor(public camera: ReolinkNativeBatteryCamera, nativeId: string) {
        super(nativeId);
    }

    async setBrightness(brightness: number): Promise<void> {
        this.brightness = brightness;
        await this.camera.setFloodlightState(undefined, brightness);
    }

    async turnOff(): Promise<void> {
        this.on = false;
        await this.camera.setFloodlightState(false);
    }

    async turnOn(): Promise<void> {
        this.on = true;
        await this.camera.setFloodlightState(true);
    }
}

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

export class ReolinkNativeBatteryCamera extends ScryptedDeviceBase implements Camera, VideoCamera, Settings, DeviceProvider {
    private streamManager: StreamManager;
    private cachedVideoStreamOptions: UrlMediaStreamOptions[] | undefined;
    private pirSensor: ReolinkBatteryPirSensor | undefined;
    private siren: ReolinkBatterySiren | undefined;
    private floodlight: ReolinkBatteryFloodlight | undefined;
    private initAttempts = 0;
    private fetchingStreams = false;
    private lastPicture: { mo: MediaObject; atMs: number } | undefined;
    private takePictureInFlight: Promise<MediaObject> | undefined;
    /**
     * IMPORTANT for BCUDP stability:
     * Battery cams can disconnect the active UDP stream if we establish a second concurrent BCUDP session.
     * Reuse the same logged-in UDP client for streaming + snapshots/ops while streaming.
     */
    private streamBaichuanApi: ReolinkBaichuanApi | undefined;
    private streamBaichuanApiLoginPromise: Promise<ReolinkBaichuanApi> | undefined;

    /**
     * When we're NOT streaming, background tasks (snapshots, prebuffer, option refresh) can fire concurrently.
     * Creating multiple BCUDP sessions in parallel makes the camera rotate did/cid and breaks login/streaming.
     * Keep one shared "idle" session with refcount + delayed close to prevent session storms.
     */
    private idleBaichuanApi: ReolinkBaichuanApi | undefined;
    private idleBaichuanApiLoginPromise: Promise<ReolinkBaichuanApi> | undefined;
    private idleBaichuanApiRefCount = 0;
    private idleBaichuanApiCloseTimer: NodeJS.Timeout | undefined;

    storageSettings = new StorageSettings(this, {
        ipAddress: { title: "IP Address", type: "string" },
        uid: { title: "UID", description: "Reolink UID (required for battery cameras / BCUDP).", type: "string" },
        username: { title: "Username", type: "string" },
        password: { title: "Password", type: "password" },
        snapshotCacheMinutes: {
            title: "Snapshot Cache Minutes",
            group: 'Advanced',
            description: "Return a cached snapshot if taken within the last N minutes.",
            type: "number",
            defaultValue: 5,
        },
        rtspChannel: { type: "number", hide: true, defaultValue: 0 },
        capabilities: { json: true, hide: true },
        mixinsSetup: { type: 'boolean', hide: true },
    });

    constructor(nativeId: string, public plugin: ReolinkNativePlugin) {
        super(nativeId);

        this.streamManager = new StreamManager({
            createStreamClient: () => this.createStreamClient(),
            getLogger: () => this.console,
        });

        setTimeout(async () => {
            await this.init();
        }, 2000);
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

    private getRtspChannel(): number {
        const channel = this.storageSettings.values.rtspChannel;
        return channel !== undefined ? Number(channel) : 0;
    }

    private getCapabilities(): any {
        return this.storageSettings.values.capabilities;
    }

    private hasPir(): boolean {
        return Boolean(this.getCapabilities()?.hasPir);
    }

    private hasSiren(): boolean {
        return Boolean(this.getCapabilities()?.hasSiren);
    }

    private hasFloodlight(): boolean {
        return Boolean(this.getCapabilities()?.hasFloodlight);
    }

    async init(): Promise<void> {
        this.initAttempts++;

        try {
            await this.reportDevices();
        } catch {
            // ignore
        }

        try {
            await this.updateDeviceInfo();
        } catch {
            // ignore
        }

        if (!this.storageSettings.values.mixinsSetup) {
            const device = sdk.systemManager.getDeviceById<Settings>(this.id);
            this.console.log('Disabling prebbufer and snapshots from prebuffer');
            await device.putSetting('prebuffer:enabledStreams', '[]');
            await device.putSetting('snapshot:snapshotsFromPrebuffer', 'Disabled');
            this.storageSettings.values.mixinsSetup = true;
        }
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
                    keepAliveInterval: 0,
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

    async updateDeviceInfo(): Promise<void> {
        // Intentionally no API calls here.
        const ip = this.storageSettings.values.ipAddress;
        if (!ip) return;

        const info = this.info || {};
        info.ip = ip;
        info.manufacturer = "Reolink native";
        info.managementUrl = `http://${ip}`;
        this.info = info;
    }

    private async withBaichuanClient<T>(fn: (api: ReolinkBaichuanApi) => Promise<T>): Promise<T> {
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

    private async createStreamClient(): Promise<ReolinkBaichuanApi> {
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
                    // For BCUDP streaming sessions, avoid BC-level Ping keepalive (cmd 93).
                    keepAliveInterval: 0,
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

    async getVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        if (this.cachedVideoStreamOptions?.length) return this.cachedVideoStreamOptions;

        while (this.fetchingStreams) {
            // this.console.log('Waiting for concurrent stream fetch to complete...');
            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        try {
            this.fetchingStreams = true;
            // this.console.log('Fetching video stream options from camera...');
            const channel = this.getRtspChannel();
            const streams = await this.withBaichuanClient(async (api) => {
                return fetchVideoStreamOptionsFromApi(api, channel);
            });
            // this.console.log(`Fetched ${streams.length} video stream options from camera.`);

            this.cachedVideoStreamOptions = streams;
            this.fetchingStreams = false;
            return streams;
        } catch (e) {
            this.console.log('Error fetching video stream options', e);
        } finally {
            this.fetchingStreams = false;
        }
    }

    async getVideoStream(vso: RequestMediaStreamOptions): Promise<MediaObject> {
        if (!vso) throw new Error("video streams not set up or no longer exists.");

        const vsos = await this.getVideoStreamOptions();
        const selected = selectStreamOption(vsos, vso);
        this.console.log(`Creating video stream for option id=${selected.id} name=${selected.name}`);

        const profile = parseStreamProfileFromId(selected.id) || "main";
        const channel = this.getRtspChannel();
        const streamKey = `${channel}_${profile}`;
        const expectedVideoType = expectedVideoTypeFromUrlMediaStreamOptions(selected);

        return await createRfc4571MediaObjectFromStreamManager({
            streamManager: this.streamManager,
            channel,
            profile,
            streamKey,
            expectedVideoType,
            selected,
            sourceId: this.id,
            onDetectedCodec: (detectedCodec) => {
                const id = profile === "main" ? "mainstream" : profile === "sub" ? "substream" : "extstream";
                const name = profile === "main" ? "Main Stream" : profile === "sub" ? "Sub Stream" : "Ext Stream";

                const prev = this.cachedVideoStreamOptions ?? [];
                const next = prev.filter((s) => s.id !== id);
                next.push({ name, id, container: "rtp", video: { codec: detectedCodec }, url: `` });
                this.cachedVideoStreamOptions = next;
            },
        });
    }

    async getSettings(): Promise<Setting[]> {
        return await this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: string): Promise<void> {
        await this.storageSettings.putSetting(key, value);
    }

    async reportDevices(): Promise<void> {
        const devices: Device[] = [];

        if (this.hasSiren()) {
            const sirenNativeId = `${this.nativeId}-siren`;
            devices.push({
                providerNativeId: this.nativeId,
                name: `${this.name} Siren`,
                nativeId: sirenNativeId,
                info: {
                    ...(this.info || {}),
                },
                interfaces: [ScryptedInterface.OnOff],
                type: ScryptedDeviceType.Siren,
            });
        }

        if (this.hasFloodlight()) {
            const floodlightNativeId = `${this.nativeId}-floodlight`;
            devices.push({
                providerNativeId: this.nativeId,
                name: `${this.name} Floodlight`,
                nativeId: floodlightNativeId,
                info: {
                    ...(this.info || {}),
                },
                interfaces: [ScryptedInterface.OnOff],
                type: ScryptedDeviceType.Light,
            });
        }

        if (this.hasPir()) {
            const pirNativeId = `${this.nativeId}-pir`;
            devices.push({
                providerNativeId: this.nativeId,
                name: `${this.name} PIR`,
                nativeId: pirNativeId,
                info: {
                    ...(this.info || {}),
                },
                interfaces: [ScryptedInterface.OnOff],
                type: ScryptedDeviceType.Switch,
            });
        }

        sdk.deviceManager.onDevicesChanged({
            providerNativeId: this.nativeId,
            devices,
        });
    }

    async getDevice(nativeId: string): Promise<any> {
        if (nativeId.endsWith("-pir")) {
            this.pirSensor ||= new ReolinkBatteryPirSensor(this, nativeId);
            return this.pirSensor;
        }

        if (nativeId.endsWith("-siren")) {
            this.siren ||= new ReolinkBatterySiren(this, nativeId);
            return this.siren;
        }

        if (nativeId.endsWith("-floodlight")) {
            this.floodlight ||= new ReolinkBatteryFloodlight(this, nativeId);
            return this.floodlight;
        }
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        if (nativeId.endsWith("-pir")) {
            this.pirSensor = undefined;
        }

        if (nativeId.endsWith("-siren")) {
            this.siren = undefined;
        }

        if (nativeId.endsWith("-floodlight")) {
            this.floodlight = undefined;
        }
    }

    async setPirEnabled(enabled: boolean): Promise<void> {
        const channel = this.getRtspChannel();
        await this.withBaichuanClient(async (api) => {
            await api.setPirInfo(channel, { enable: enabled ? 1 : 0 });
            return;
        });
    }

    async setSirenEnabled(enabled: boolean): Promise<void> {
        const channel = this.getRtspChannel();
        await this.withBaichuanClient(async (api) => {
            await api.setSiren(channel, enabled);
            return;
        });
    }

    async setFloodlightState(on?: boolean, brightness?: number): Promise<void> {
        const channel = this.getRtspChannel();
        await this.withBaichuanClient(async (api) => {
            await api.setWhiteLedState(channel, on, brightness);
            return;
        });
    }

    getScryptedDeviceType(): string {
        return "Camera";
    }

    getScryptedDeviceInterfaces(): string[] {
        // Interfaces are managed by discovery (main.ts/getDeviceInterfaces).
        return [ScryptedInterface.VideoCamera, ScryptedInterface.Settings, ScryptedInterface.DeviceProvider];
    }
}
