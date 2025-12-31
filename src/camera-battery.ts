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

/**
 * Minimal battery/UDP device.
 *
 * Constraints (by design):
 * - no polling, no snapshots, no events, no extra feature calls
 * - the only Baichuan API interaction is creating/using the streaming session
 */
export class ReolinkNativeBatteryCamera extends ScryptedDeviceBase implements VideoCamera, Settings, DeviceProvider {
    private streamManager: StreamManager;
    private cachedVideoStreamOptions: UrlMediaStreamOptions[] | undefined;
    private pirSensor: ReolinkBatteryPirSensor | undefined;
    private siren: ReolinkBatterySiren | undefined;
    private floodlight: ReolinkBatteryFloodlight | undefined;
    private initAttempts = 0;
    private fetchingStreams = false;

    storageSettings = new StorageSettings(this, {
        ipAddress: { title: "IP Address", type: "string" },
        uid: { title: "UID", description: "Reolink UID (required for battery cameras / BCUDP).", type: "string" },
        username: { title: "Username", type: "string" },
        password: { title: "Password", type: "password" },
        rtspChannel: { type: "number", hide: true, defaultValue: 0 },
        capabilities: { json: true, hide: true },
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

        // If main.ts hasn't populated capabilities yet, retry discovery shortly.
        if (!this.storageSettings.values.capabilities && this.initAttempts < 5) {
            setTimeout(() => {
                this.init().catch(() => {
                    // ignore
                });
            }, 2000);
        }
    }

    async release(): Promise<void> {
        // No background tasks to stop; RFC4571 server tears down its own stream API.
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
        const { ipAddress, username, password, uid } = this.storageSettings.values;
        if (!ipAddress || !username || !password) throw new Error("Missing camera credentials");
        const normalizedUid = normalizeUid(uid);
        if (!normalizedUid) throw new Error("UID is required for battery cameras (BCUDP)");

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
        try {
            return await fn(api);
        } finally {
            await api.close();
        }
    }

    private async createStreamClient(): Promise<ReolinkBaichuanApi> {
        const { ipAddress, username, password, uid } = this.storageSettings.values;
        if (!ipAddress || !username || !password) throw new Error("Missing camera credentials");
        const normalizedUid = normalizeUid(uid);
        if (!normalizedUid) throw new Error("UID is required for battery cameras (BCUDP)");

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
        return api;
    }

    async getVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        if (this.cachedVideoStreamOptions?.length) return this.cachedVideoStreamOptions;

        while (this.fetchingStreams) {
            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        try {
            this.fetchingStreams = true;
            const channel = this.getRtspChannel();
            const streams = await this.withBaichuanClient(async (api) => {
                return fetchVideoStreamOptionsFromApi(api, channel);
            });

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
