import type { BatteryInfo, DeviceCapabilities, PtzCommand, ReolinkBaichuanApi, ReolinkSimpleEvent, StreamProfile } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { Brightness, Camera, Device, DeviceProvider, Intercom, MediaObject, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, OnOff, PanTiltZoom, PanTiltZoomCommand, RequestMediaStreamOptions, RequestPictureOptions, ResponseMediaStreamOptions, ResponsePictureOptions, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, Sleep, VideoCamera, VideoTextOverlay, VideoTextOverlays } from "@scrypted/sdk";
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { RtspClient } from "../../scrypted/common/src/rtsp-server";
import { UrlMediaStreamOptions } from "../../scrypted/plugins/rtsp/src/rtsp";
import { ReolinkBaichuanIntercom } from "./intercom";
import ReolinkNativePlugin from "./main";
import { parseStreamProfileFromId, StreamManager } from './stream-utils';

export const moToB64 = async (mo: MediaObject) => {
    const bufferImage = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
    return bufferImage?.toString('base64');
}

export const b64ToMo = async (b64: string) => {
    const buffer = Buffer.from(b64, 'base64');
    return await sdk.mediaManager.createMediaObject(buffer, 'image/jpeg');
}

class ReolinkCameraSiren extends ScryptedDeviceBase implements OnOff {
    sirenTimeout: NodeJS.Timeout;

    constructor(public camera: ReolinkNativeCamera, nativeId: string) {
        super(nativeId);
    }

    async turnOff() {
        this.on = false;
        await this.setSiren(false);
    }

    async turnOn() {
        this.on = true;
        await this.setSiren(true);
    }

    private async setSiren(on: boolean) {
        const api = this.camera.getClient();
        if (!api) return;

        await api.setSiren(this.camera.getRtspChannel(), on);
    }
}

class ReolinkCameraFloodlight extends ScryptedDeviceBase implements OnOff, Brightness {
    constructor(public camera: ReolinkNativeCamera, nativeId: string) {
        super(nativeId);
    }

    async setBrightness(brightness: number): Promise<void> {
        this.brightness = brightness;
        await this.setFloodlight(undefined, brightness);
    }

    async turnOff() {
        this.on = false;
        await this.setFloodlight(false);
    }

    async turnOn() {
        this.on = true;
        await this.setFloodlight(true);
    }

    private async setFloodlight(on?: boolean, brightness?: number) {
        const api = this.camera.getClient();
        if (!api) return;

        await api.setWhiteLedState(this.camera.getRtspChannel(), on, brightness);
    }
}

class ReolinkCameraPirSensor extends ScryptedDeviceBase implements OnOff {
    constructor(public camera: ReolinkNativeCamera, nativeId: string) {
        super(nativeId);
    }

    async turnOff() {
        this.on = false;
        await this.setPir(false);
    }

    async turnOn() {
        this.on = true;
        await this.setPir(true);
    }

    private async setPir(on: boolean) {
        const api = this.camera.getClient();
        if (!api) return;

        await api.setPirInfo(this.camera.getRtspChannel(), { enable: on ? 1 : 0 });
    }
}

// export class ReolinkNativeCamera extends ScryptedDeviceBase implements Camera, DeviceProvider, Intercom, ObjectDetector, PanTiltZoom, Sleep, VideoTextOverlays {
export class ReolinkNativeCamera extends ScryptedDeviceBase implements VideoCamera, Settings, Camera, DeviceProvider, Intercom, ObjectDetector, PanTiltZoom, Sleep, VideoTextOverlays {
    videoStreamOptions: Promise<UrlMediaStreamOptions[]>;
    motionTimeout: NodeJS.Timeout;
    siren: ReolinkCameraSiren;
    floodlight: ReolinkCameraFloodlight;
    pirSensor: ReolinkCameraPirSensor;
    private baichuanApi: ReolinkBaichuanApi | undefined;
    private baichuanInitPromise: Promise<ReolinkBaichuanApi> | undefined;
    private refreshDeviceStatePromise: Promise<void> | undefined;

    private subscribedToEvents = false;
    private onSimpleEvent: ((ev: ReolinkSimpleEvent) => void) | undefined;
    private eventsApi: ReolinkBaichuanApi | undefined;

    private periodicStarted = false;
    private statusPollTimer: NodeJS.Timeout | undefined;
    private eventsRestartTimer: NodeJS.Timeout | undefined;
    private lastActivityMs = Date.now();
    private lastB64Snapshot: string | undefined;
    private lastSnapshotTaken: number | undefined;
    private streamManager: StreamManager;

    private dispatchEventsApplyTimer: NodeJS.Timeout | undefined;
    private dispatchEventsApplySeq = 0;

    private lastAppliedDispatchEventsKey: string | undefined;

    intercomClient: RtspClient;

    private intercom: ReolinkBaichuanIntercom;

    storageSettings = new StorageSettings(this, {
        ipAddress: {
            title: 'IP Address',
            type: 'string',
        },
        username: {
            type: 'string',
            title: 'Username',
        },
        password: {
            type: 'password',
            title: 'Password',
        },
        rtspChannel: {
            type: 'number',
            hide: true,
            defaultValue: 0
        },
        capabilities: {
            json: true,
            hide: true
        },
        dispatchEvents: {
            subgroup: 'Advanced',
            title: 'Dispatch Events',
            description: 'Select which events to emit. Empty disables event subscription entirely.',
            multiple: true,
            combobox: true,
            immediate: true,
            defaultValue: ['motion', 'objects'],
            choices: ['motion', 'objects'],
            onPut: async () => {
                this.scheduleApplyEventDispatchSettings();
            },
        },
        debugLogs: {
            subgroup: 'Advanced',
            title: 'Debug Logs',
            description: 'Enable specific debug logs. Baichuan client logs require reconnect; event logs are immediate.',
            multiple: true,
            combobox: true,
            immediate: true,
            defaultValue: [],
            choices: ['enabled', 'debugRtsp', 'traceStream', 'traceTalk', 'debugH264', 'debugParamSets', 'eventLogs'],
            onPut: async (ov, value) => {
                // Only reconnect if Baichuan-client flags changed; toggling event logs should be immediate.
                const oldSel = new Set(ov);
                const newSel = new Set(value);
                oldSel.delete('eventLogs');
                newSel.delete('eventLogs');

                const changed = oldSel.size !== newSel.size || Array.from(oldSel).some((k) => !newSel.has(k));
                if (changed) {
                    await this.resetBaichuanClient('debugLogs changed');
                }
            },
        },
        motionTimeout: {
            subgroup: 'Advanced',
            title: 'Motion Timeout',
            defaultValue: 20,
            type: 'number',
        },
        presets: {
            subgroup: 'Advanced',
            title: 'Presets',
            description: 'PTZ Presets in the format "id=name". Where id is the PTZ Preset identifier and name is a friendly name.',
            multiple: true,
            defaultValue: [],
            combobox: true,
            onPut: async (ov, presets: string[]) => {
                const caps = {
                    ...this.ptzCapabilities,
                    presets: {},
                };
                for (const preset of presets) {
                    const [key, name] = preset.split('=');
                    caps.presets[key] = name;
                }
                this.ptzCapabilities = caps;
            },
            mapGet: () => {
                const presets = this.ptzCapabilities?.presets || {};
                return Object.entries(presets).map(([key, name]) => key + '=' + name);
            },
        },
        cachedPresets: {
            multiple: true,
            hide: true,
            json: true,
            defaultValue: [],
        },
        // cachedOsd: {
        //     multiple: true,
        //     hide: true,
        //     json: true,
        //     defaultValue: [],
        // },
        prebufferSet: {
            type: 'boolean',
            hide: true
        },
        ptzMoveDurationMs: {
            subgroup: 'Advanced',
            title: 'PTZ Move Duration (ms)',
            description: 'How long a PTZ command moves before sending stop. Higher = more movement per click.',
            type: 'number',
            defaultValue: 500,
        },
        ptzZoomStep: {
            subgroup: 'Advanced',
            title: 'PTZ Zoom Step',
            description: 'How much to change zoom per zoom command (in zoom factor units, where 1.0 is normal).',
            type: 'number',
            defaultValue: 0.2,
        },
        intercomBlocksPerPayload: {
            subgroup: 'Advanced',
            title: 'Intercom Blocks Per Payload',
            description: 'Lower reduces latency (more packets). Typical: 1-4. Requires restarting talk session to take effect.',
            type: 'number',
            defaultValue: 1,
            onPut: async (ov, value: number) => {
                (this.storageSettings.values as any).intercomBlocksPerPayload = value;
                this.intercom.setBlocksPerPayload(value);
            },
        },
    });

    constructor(nativeId: string, public plugin: ReolinkNativePlugin) {
        super(nativeId);

        this.streamManager = new StreamManager({
            ensureClient: () => this.ensureClient(),
            getLogger: () => this.getLogger(),
        });

        this.intercom = new ReolinkBaichuanIntercom({
            markActivity: () => this.markActivity(),
            getLogger: () => this.getLogger(),
            getRtspChannel: () => this.getRtspChannel(),
            ensureClient: () => this.ensureClient(),
            withBaichuanRetry: (fn) => this.withBaichuanRetry(fn),
        });

        this.intercom.setBlocksPerPayload((this.storageSettings.values as any).intercomBlocksPerPayload);

        this.storageSettings.settings.presets.onGet = async () => {
            const choices = this.storageSettings.values.cachedPresets.map((preset) => preset.id + '=' + preset.name);
            return {
                choices,
            };
        };

        setTimeout(async () => {
            await this.init();
        }, 2000);
    }

    private isRecoverableBaichuanError(e: any): boolean {
        const message = e?.message || e?.toString?.() || '';
        return typeof message === 'string' && (
            message.includes('Baichuan socket closed') ||
            message.includes('socket hang up') ||
            message.includes('ECONNRESET') ||
            message.includes('EPIPE')
        );
    }

    private async resetBaichuanClient(reason?: any): Promise<void> {
        try {
            await this.baichuanApi?.close();
        }
        catch (e) {
            this.getLogger().warn('Error closing Baichuan client during reset', e);
        }
        finally {
            if (this.eventsApi && this.onSimpleEvent) {
                try {
                    this.eventsApi.simpleEvents.off('event', this.onSimpleEvent);
                }
                catch {
                    // ignore
                }
            }
            this.baichuanApi = undefined;
            this.baichuanInitPromise = undefined;
            this.subscribedToEvents = false;
            this.eventsApi = undefined;
        }

        if (reason) {
            const message = reason?.message || reason?.toString?.() || reason;
            this.getLogger().warn(`Baichuan client reset requested: ${message}`);
        }
    }

    private async withBaichuanRetry<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        }
        catch (e) {
            if (!this.isRecoverableBaichuanError(e)) {
                throw e;
            }

            await this.resetBaichuanClient(e);
            return await fn();
        }
    }

    public getLogger() {
        return this.console;
    }

    async init() {
        const logger = this.getLogger();

        // Migrate older boolean value to the new multi-select format.
        this.migrateDispatchEventsSetting();
        this.migrateDebugEventLogsSetting();

        // Initialize Baichuan API
        await this.ensureClient();

        // Refresh cached device metadata/abilities as early as possible, since we use them for interface gating.
        await this.refreshDeviceState();

        await this.reportDevices();
        this.updateDeviceInfo();
        this.updatePtzCaps();

        const interfaces = await this.getDeviceInterfaces();

        const device: Device = {
            nativeId: this.nativeId,
            providerNativeId: this.plugin.nativeId,
            name: this.name,
            interfaces,
            type: this.type as ScryptedDeviceType,
            info: this.info,
        };

        logger.log(`Updating device interfaces: ${JSON.stringify(interfaces)}`);

        await sdk.deviceManager.onDeviceDiscovered(device);

        // Start event subscription after discovery.
        try {
            if (this.isEventDispatchEnabled()) {
                await this.ensureBaichuanEventSubscription();
            }
        }
        catch (e) {
            logger.warn('Failed to subscribe to Baichuan events', e);
        }

        // Periodic status refresh + event resubscribe.
        this.startPeriodicTasks();

        if (this.hasBattery() && !this.storageSettings.getItem('prebufferSet')) {
            const device = sdk.systemManager.getDeviceById<Settings>(this.id);
            logger.log('Disabling prebbufer for battery cam');
            await device.putSetting('prebuffer:enabledStreams', '[]');
            this.storageSettings.values.prebufferSet = true;
        }
    }

    private async ensureClient(): Promise<ReolinkBaichuanApi> {
        if (this.baichuanInitPromise) {
            return this.baichuanInitPromise;
        }

        if (this.baichuanApi && this.baichuanApi.client.loggedIn) {
            return this.baichuanApi;
        }

        const { ipAddress, username, password } = this.storageSettings.values;

        if (!ipAddress || !username || !password) {
            throw new Error('Missing camera credentials');
        }

        this.baichuanInitPromise = (async () => {
            if (this.baichuanApi) {
                await this.baichuanApi.close();
            }

            const { ReolinkBaichuanApi } = await import("@apocaliss92/reolink-baichuan-js");
            const debugOptions = this.getBaichuanDebugOptions();
            this.baichuanApi = new ReolinkBaichuanApi({
                host: ipAddress,
                username,
                password,
                logger: this.console,
                ...(debugOptions ? { debugOptions } : {}),
            });

            await this.baichuanApi.login();
            return this.baichuanApi;
        })();

        try {
            return await this.baichuanInitPromise;
        }
        finally {
            // If login failed, allow future retries.
            if (!this.baichuanApi?.client?.loggedIn) {
                this.baichuanInitPromise = undefined;
            }
        }
    }

    getClient(): ReolinkBaichuanApi | undefined {
        return this.baichuanApi;
    }

    private async refreshDeviceState(): Promise<void> {
        if (this.refreshDeviceStatePromise) return this.refreshDeviceStatePromise;

        this.refreshDeviceStatePromise = (async () => {
            const logger = this.getLogger();
            const api = await this.ensureClient();
            const channel = this.getRtspChannel();

            try {
                const { capabilities, abilities, support, presets } = await api.getDeviceCapabilities(channel);
                this.storageSettings.values.capabilities = capabilities;
                this.storageSettings.values.cachedPresets = presets ?? [];
                this.console.log(`Refreshed device capabilities: ${JSON.stringify({ capabilities, abilities, support, presets })}`);
            }
            catch (e) {
                logger.warn('Failed to refresh abilities', e);
            }

            // Best-effort status refreshes.
            await this.refreshAuxDevicesStatus().catch(() => { });
        })().finally(() => {
            this.refreshDeviceStatePromise = undefined;
        });

        return this.refreshDeviceStatePromise;
    }

    private async ensureBaichuanEventSubscription(): Promise<void> {
        if (!this.isEventDispatchEnabled()) {
            await this.disableBaichuanEventSubscription();
            return;
        }
        if (this.subscribedToEvents) return;
        const api = await this.ensureClient();

        try {
            await api.subscribeEvents();
        }
        catch {
            // Some firmwares don't require explicit subscribe or may reject it.
        }

        this.onSimpleEvent ||= (ev: any) => {
            try {
                if (!this.isEventDispatchEnabled()) return;
                if (this.isEventLogsEnabled()) {
                    this.getLogger().debug(`Baichuan event: ${JSON.stringify(ev)}`);
                }
                const channel = this.getRtspChannel();
                if (ev?.channel !== undefined && ev.channel !== channel) return;

                const objects: string[] = [];
                let motion = false;

                switch (ev?.type) {
                    case 'motion':
                        motion = this.shouldDispatchMotion();
                        break;
                    case 'doorbell':
                        // Placeholder: treat doorbell as motion.
                        motion = this.shouldDispatchMotion();
                        break;
                    case 'people':
                    case 'vehicle':
                    case 'animal':
                    case 'face':
                    case 'package':
                    case 'other':
                        if (this.shouldDispatchObjects()) objects.push(ev.type);
                        break;
                    default:
                        return;
                }

                this.processEvents({ motion, objects }).catch(() => { });
            }
            catch {
                // ignore
            }
        };

        // Attach the handler to the current API instance, and detach from any previous instance.
        if (this.eventsApi && this.eventsApi !== api && this.onSimpleEvent) {
            try {
                this.eventsApi.simpleEvents.off('event', this.onSimpleEvent);
            }
            catch {
                // ignore
            }
        }
        if (this.eventsApi !== api && this.onSimpleEvent) {
            api.simpleEvents.on('event', this.onSimpleEvent);
            this.eventsApi = api;
        }

        this.subscribedToEvents = true;
    }

    private async disableBaichuanEventSubscription(): Promise<void> {
        // Do not wake up battery cameras / do not force login: best-effort cleanup only.
        const api = this.getClient();
        if (api?.client?.loggedIn) {
            try {
                await api.unsubscribeEvents();
            }
            catch {
                // ignore
            }
        }

        if (this.eventsApi && this.onSimpleEvent) {
            try {
                this.eventsApi.simpleEvents.off('event', this.onSimpleEvent);
            }
            catch {
                // ignore
            }
        }

        this.subscribedToEvents = false;
        this.eventsApi = undefined;

        if (this.motionTimeout) {
            clearTimeout(this.motionTimeout);
        }
        this.motionDetected = false;
    }

    private async applyEventDispatchSettings(): Promise<void> {
        const logger = this.getLogger();
        const selection = Array.from(this.getDispatchEventsSelection()).sort();
        const key = selection.join(',');
        const prevKey = this.lastAppliedDispatchEventsKey;

        if (prevKey !== undefined && prevKey !== key) {
            logger.log(`Dispatch Events changed: ${selection.length ? selection.join(', ') : '(disabled)'}`);
        }

        // User-initiated settings change counts as activity.
        this.markActivity();

        // Empty selection disables everything.
        if (!this.isEventDispatchEnabled()) {
            if (this.subscribedToEvents) {
                logger.log('Event listener stopped (Dispatch Events disabled)');
            }
            await this.disableBaichuanEventSubscription();
            this.lastAppliedDispatchEventsKey = key;
            return;
        }

        // If motion is not selected, ensure state is cleared.
        if (!this.shouldDispatchMotion()) {
            if (this.motionTimeout) clearTimeout(this.motionTimeout);
            this.motionDetected = false;
        }

        // Apply immediately even if we were already subscribed.
        // If nothing actually changed and we're already subscribed, avoid a noisy resubscribe.
        if (prevKey === key && this.subscribedToEvents) {
            // Track baseline so later changes are logged.
            this.lastAppliedDispatchEventsKey = key;
            return;
        }

        if (!this.subscribedToEvents) {
            logger.log(`Event listener started (${selection.join(', ')})`);
            await this.ensureBaichuanEventSubscription();
            this.lastAppliedDispatchEventsKey = key;
            return;
        }

        logger.log(`Event listener restarting (${selection.join(', ')})`);
        await this.disableBaichuanEventSubscription();
        await this.ensureBaichuanEventSubscription();
        this.lastAppliedDispatchEventsKey = key;
    }

    private markActivity(): void {
        this.lastActivityMs = Date.now();
    }

    private shouldAvoidWakingBatteryCamera(): boolean {
        if (!this.hasBattery()) return false;
        if (this.sleeping) return true;

        // If we don't already have an active logged-in client, don't try to connect/login.
        const api = this.getClient();
        if (!api?.client?.loggedIn) return true;

        // If there's no recent activity, avoid periodic polling/resubscribe.
        const ageMs = Date.now() - this.lastActivityMs;
        return ageMs > 30_000;
    }

    async release() {
        this.statusPollTimer && clearInterval(this.statusPollTimer);
        this.eventsRestartTimer && clearInterval(this.eventsRestartTimer);
        return this.resetBaichuanClient();
    }

    private startPeriodicTasks(): void {
        if (this.periodicStarted) return;
        this.periodicStarted = true;

        this.statusPollTimer = setInterval(() => {
            this.periodic10sTick().catch(() => { });
        }, 10_000);

        this.eventsRestartTimer = setInterval(() => {
            this.periodic60sRestartEvents().catch(() => { });
        }, 60_000);
    }

    private async periodic10sTick(): Promise<void> {
        if (this.shouldAvoidWakingBatteryCamera()) return;

        // For wired cameras, reconnecting is fine.
        if (!this.hasBattery()) {
            await this.ensureClient();
        }

        await this.refreshAuxDevicesStatus();

        // Best-effort: ensure we're subscribed.
        if (this.isEventDispatchEnabled() && !this.subscribedToEvents) {
            if (this.hasBattery()) {
                const api = this.getClient();
                if (!api?.client?.loggedIn) return;
            }
            await this.ensureBaichuanEventSubscription();
        }
    }

    private async periodic60sRestartEvents(): Promise<void> {
        if (this.shouldAvoidWakingBatteryCamera()) return;

        if (!this.isEventDispatchEnabled()) {
            await this.disableBaichuanEventSubscription();
            return;
        }

        // Wired cameras can reconnect; battery cameras only operate on an existing active client.
        if (!this.hasBattery()) {
            await this.ensureClient();
        }
        else {
            const api = this.getClient();
            if (!api?.client?.loggedIn) return;
        }

        const api = this.getClient();
        if (!api) return;

        try {
            await api.unsubscribeEvents();
        }
        catch {
            // ignore
        }

        this.subscribedToEvents = false;
        await this.ensureBaichuanEventSubscription();
    }

    private async refreshAuxDevicesStatus(): Promise<void> {
        const api = this.getClient();
        if (!api) return;

        const channel = this.getRtspChannel();

        try {
            if (this.hasFloodlight()) {
                const wl = await api.getWhiteLedState(channel);
                if (this.floodlight) {
                    this.floodlight.on = !!wl.enabled;
                    if (wl.brightness !== undefined) this.floodlight.brightness = wl.brightness;
                }
            }
        }
        catch {
            // ignore
        }

        try {
            if (this.hasPirEvents()) {
                const pir = await api.getPirInfo(channel);
                if (this.pirSensor) this.pirSensor.on = !!pir.enabled;
            }
        }
        catch {
            // ignore
        }
    }

    async getVideoTextOverlays(): Promise<Record<string, VideoTextOverlay>> {
        const client = this.getClient();
        if (!client) {
            return;
        }
        // TODO: restore
        // const { cachedOsd } = this.storageSettings.values;

        // return {
        //     osdChannel: {
        //         text: cachedOsd.value.Osd.osdChannel.enable ? cachedOsd.value.Osd.osdChannel.name : undefined,
        //     },
        //     osdTime: {
        //         text: !!cachedOsd.value.Osd.osdTime.enable,
        //         readonly: true,
        //     }
        // }
    }

    async setVideoTextOverlay(id: 'osdChannel' | 'osdTime', value: VideoTextOverlay): Promise<void> {
        const client = await this.ensureClient();
        if (!client) {
            return;
        }
        // TODO: restore

        // const osd = await client.getOsd();

        // if (id === 'osdChannel') {
        //     osd.osdChannel.enable = value.text ? 1 : 0;
        //     // name must always be valid.
        //     osd.osdChannel.name = typeof value.text === 'string' && value.text
        //         ? value.text
        //         : osd.osdChannel.name || 'Camera';
        // }
        // else if (id === 'osdTime') {
        //     osd.osdTime.enable = value.text ? 1 : 0;
        // }
        // else {
        //     throw new Error('unknown overlay: ' + id);
        // }

        // await client.setOsd(channel, osd);
    }

    updatePtzCaps() {
        const { hasPanTilt, hasZoom } = this.getPtzCapabilities();
        this.ptzCapabilities = {
            ...this.ptzCapabilities,
            pan: hasPanTilt,
            tilt: hasPanTilt,
            zoom: hasZoom,
        }
    }

    getAbilities(): DeviceCapabilities {
        return this.storageSettings.values.capabilities;
    }

    async getDetectionInput(detectionId: string, eventId?: any): Promise<MediaObject> {
        return null;
    }

    async ptzCommand(command: PanTiltZoomCommand): Promise<void> {
        this.markActivity();
        const client = await this.ensureClient();
        if (!client) {
            return;
        }

        const channel = this.getRtspChannel();

        // Map PanTiltZoomCommand to PtzCommand
        let ptzAction: 'start' | 'stop' = 'start';
        let ptzCommand: 'Left' | 'Right' | 'Up' | 'Down' | 'ZoomIn' | 'ZoomOut' | 'FocusNear' | 'FocusFar' = 'Left';

        if (command.pan !== undefined) {
            if (command.pan === 0) {
                // Stop pan movement - send stop with last direction
                ptzAction = 'stop';
                ptzCommand = 'Left'; // Use any direction for stop
            } else {
                ptzCommand = command.pan > 0 ? 'Right' : 'Left';
                ptzAction = 'start';
            }
        } else if (command.tilt !== undefined) {
            if (command.tilt === 0) {
                // Stop tilt movement
                ptzAction = 'stop';
                ptzCommand = 'Up'; // Use any direction for stop
            } else {
                ptzCommand = command.tilt > 0 ? 'Up' : 'Down';
                ptzAction = 'start';
            }
        } else if (command.zoom !== undefined) {
            // Zoom is handled separately.
            // Scrypted typically provides a normalized zoom value; treat it as direction and apply a step.
            const z = Number(command.zoom);
            if (!Number.isFinite(z) || z === 0) return;

            const step = Number(this.storageSettings.values.ptzZoomStep);
            const stepFactor = Number.isFinite(step) && step > 0 ? step : 0.2;

            const info = await client.getZoomFocus(channel);
            if (!info?.zoom) {
                this.getLogger().warn('Zoom command requested but camera did not report zoom support.');
                return;
            }

            // In Baichuan API, 1000 == 1.0x.
            const curFactor = (info.zoom.curPos ?? 1000) / 1000;
            const minFactor = (info.zoom.minPos ?? 1000) / 1000;
            const maxFactor = (info.zoom.maxPos ?? 1000) / 1000;

            const direction = z > 0 ? 1 : -1;
            const next = Math.min(maxFactor, Math.max(minFactor, curFactor + direction * stepFactor));
            await client.zoomToFactor(channel, next);
            return;
        }

        const ptzCmd: PtzCommand = {
            action: ptzAction,
            command: ptzCommand,
            speed: typeof command.speed === 'number' ? command.speed : 32,
            autoStopMs: Number(this.storageSettings.values.ptzMoveDurationMs) || 500,
        };

        await client.ptz(channel, ptzCmd);
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        try {
            const client = await this.ensureClient();
            const ai = await client.getAiState();

            const classes: string[] = [];
            // AI state structure may vary, check if it's an object with support field
            if (ai && typeof ai === 'object' && 'support' in ai) {
                if (ai.support) {
                    // Add common AI types if supported
                    classes.push('people', 'vehicle', 'dog_cat', 'face', 'package');
                }
            }

            return {
                classes,
            };
        }
        catch (e) {
            return {
                classes: [],
            };
        }
    }

    hasSiren() {
        const capabilities = this.getAbilities();
        return Boolean(capabilities?.hasSiren);
    }

    hasFloodlight() {
        const capabilities = this.getAbilities();
        return Boolean(capabilities?.hasFloodlight);
    }

    hasBattery() {
        const capabilities = this.getAbilities();
        return Boolean(capabilities?.hasBattery);
    }

    getPtzCapabilities() {
        const capabilities = this.getAbilities();
        const hasZoom = Boolean(capabilities?.hasZoom);
        const hasPanTilt = Boolean(capabilities?.hasPan && capabilities?.hasTilt);
        const hasPresets = Boolean(capabilities?.hasPresets);

        return {
            hasZoom,
            hasPanTilt,
            hasPresets,
            hasPtz: hasZoom || hasPanTilt || hasPresets,
        };
    }

    hasPtzCtrl() {
        const capabilities = this.getAbilities();
        return Boolean(capabilities?.hasPtz);
    }

    hasPirEvents() {
        const capabilities = this.getAbilities();
        return Boolean(capabilities?.hasPir);
    }

    async getDeviceInterfaces() {
        const interfaces = [
            ScryptedInterface.VideoCamera,
            ScryptedInterface.Settings,
            ...this.plugin.getCameraInterfaces(),
        ];

        try {
            // Expose Intercom if the camera supports Baichuan talkback.
            try {
                const api = this.getClient();
                if (api) {
                    const ability = await api.getTalkAbility(this.getRtspChannel());
                    if (Array.isArray((ability as any)?.audioConfigList) && (ability as any).audioConfigList.length > 0) {
                        interfaces.push(ScryptedInterface.Intercom);
                    }
                }
            }
            catch {
                // ignore: camera likely doesn't support talkback
            }

            const { hasPtz } = this.getPtzCapabilities();

            if (hasPtz) {
                interfaces.push(ScryptedInterface.PanTiltZoom);
            }
            if ((await this.getObjectTypes()).classes.length > 0) {
                interfaces.push(ScryptedInterface.ObjectDetector);
            }
            if (this.hasSiren() || this.hasFloodlight() || this.hasPirEvents())
                interfaces.push(ScryptedInterface.DeviceProvider);
            if (this.hasBattery()) {
                interfaces.push(ScryptedInterface.Battery, ScryptedInterface.Sleep);
            }
        } catch (e) {
            this.getLogger().error('Error getting device interfaces', e);
        }

        return interfaces;
    }

    async processBatteryData(data: BatteryInfo) {
        const logger = this.getLogger();
        const batteryLevel = data.batteryPercent;
        const sleeping = data.sleeping || false;
        // const debugEvents = this.storageSettings.values.debugEvents;

        // if (debugEvents) {
        //     logger.debug(`Battery info received: ${JSON.stringify(data)}`);
        // }

        if (sleeping !== this.sleeping) {
            this.sleeping = sleeping;
        }

        if (batteryLevel !== this.batteryLevel) {
            this.batteryLevel = batteryLevel ?? this.batteryLevel;
        }
    }

    async processDeviceStatusData(data: { floodlightEnabled?: boolean; pirEnabled?: boolean; ptzPresets?: any[]; osd?: any }) {
        const { floodlightEnabled, pirEnabled, ptzPresets, osd } = data;
        const logger = this.getLogger();

        // const debugEvents = this.storageSettings.values.debugEvents;
        // if (debugEvents) {
        //     logger.info(`Device status received: ${JSON.stringify(data)}`);
        // }

        if (this.floodlight && floodlightEnabled !== this.floodlight.on) {
            this.floodlight.on = floodlightEnabled;
        }

        if (this.pirSensor && pirEnabled !== this.pirSensor.on) {
            this.pirSensor.on = pirEnabled;
        }

        if (ptzPresets) {
            this.storageSettings.values.cachedPresets = ptzPresets
        }

        // if (osd) {
        //     this.storageSettings.values.cachedOsd = osd
        // }
    }

    async updateDeviceInfo() {
        const ip = this.storageSettings.values.ipAddress;
        if (!ip)
            return;

        const api = await this.ensureClient();
        const deviceData = await api.getInfo();
        const info = this.info || {};
        info.ip = ip;

        info.serialNumber = deviceData?.serialNumber || deviceData?.itemNo;
        info.firmware = deviceData?.firmwareVersion || deviceData?.firmVer;
        info.version = deviceData?.hardwareVersion || deviceData?.boardInfo;
        info.model = deviceData?.type || deviceData?.typeInfo;
        info.manufacturer = 'Reolink native';
        info.managementUrl = `http://${ip}`;
        this.info = info;
    }

    async processEvents(events: { motion?: boolean; objects?: string[] }) {
        const logger = this.getLogger();

        if (!this.isEventDispatchEnabled()) return;

        if (this.isEventLogsEnabled()) {
            logger.debug(`Events received: ${JSON.stringify(events)}`);
        }

        // const debugEvents = this.storageSettings.values.debugEvents;
        // if (debugEvents) {
        //     logger.debug(`Events received: ${JSON.stringify(events)}`);
        // }

        if (this.shouldDispatchMotion() && events.motion !== this.motionDetected) {
            if (events.motion) {
                this.motionDetected = true;
                this.motionTimeout && clearTimeout(this.motionTimeout);
                this.motionTimeout = setTimeout(() => this.motionDetected = false, this.storageSettings.values.motionTimeout * 1000);
            }
            else {
                this.motionDetected = false;
                this.motionTimeout && clearTimeout(this.motionTimeout);
            }
        }

        if (this.shouldDispatchObjects() && events.objects?.length) {
            const od: ObjectsDetected = {
                timestamp: Date.now(),
                detections: [],
            };
            for (const c of events.objects) {
                od.detections.push({
                    className: c,
                    score: 1,
                });
            }
            sdk.deviceManager.onDeviceEvent(this.nativeId, ScryptedInterface.ObjectDetector, od);
        }
    }

    private normalizeDebugLogs(value: unknown): string[] {
        const allowed = new Set(['enabled', 'debugRtsp', 'traceStream', 'traceTalk', 'debugH264', 'debugParamSets', 'eventLogs']);

        const items = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
        const out: string[] = [];
        for (const v of items) {
            if (typeof v !== 'string') continue;
            const s = v.trim();
            if (!allowed.has(s)) continue;
            out.push(s);
        }
        return Array.from(new Set(out));
    }

    private getBaichuanDebugOptions(): any | undefined {
        const sel = new Set(this.normalizeDebugLogs((this.storageSettings.values as any).debugLogs));
        if (!sel.size) return undefined;

        // Keep this as `any` so we don't need to import DebugOptions types here.
        const debugOptions: any = {};
        // Only pass through Baichuan client debug flags.
        const clientKeys = new Set(['enabled', 'debugRtsp', 'traceStream', 'traceTalk', 'debugH264', 'debugParamSets']);
        for (const k of sel) {
            if (!clientKeys.has(k)) continue;
            debugOptions[k] = true;
        }
        return Object.keys(debugOptions).length ? debugOptions : undefined;
    }

    private isEventLogsEnabled(): boolean {
        const sel = new Set(this.normalizeDebugLogs((this.storageSettings.values as any).debugLogs));
        return sel.has('eventLogs');
    }

    private getDispatchEventsSelection(): Set<'motion' | 'objects'> {
        return new Set(this.storageSettings.values.dispatchEvents);
    }

    private isEventDispatchEnabled(): boolean {
        return this.getDispatchEventsSelection().size > 0;
    }

    private shouldDispatchMotion(): boolean {
        return this.getDispatchEventsSelection().has('motion');
    }

    private shouldDispatchObjects(): boolean {
        return this.getDispatchEventsSelection().has('objects');
    }

    private migrateDispatchEventsSetting(): void {
        const cur = (this.storageSettings.values as any).dispatchEvents;
        if (typeof cur === 'boolean') {
            (this.storageSettings.values as any).dispatchEvents = cur ? ['motion', 'objects'] : [];
        }
    }

    private migrateDebugEventLogsSetting(): void {
        // Back-compat: old boolean debugEventLogs -> new debugLogs choice "eventLogs".
        const legacy = (this.storageSettings.values as any).debugEventLogs;
        if (typeof legacy !== 'boolean') return;

        const sel = new Set(this.normalizeDebugLogs((this.storageSettings.values as any).debugLogs));
        if (legacy) {
            sel.add('eventLogs');
            (this.storageSettings.values as any).debugLogs = Array.from(sel);
        }

        // Keep storage clean-ish (even if key may remain persisted).
        (this.storageSettings.values as any).debugEventLogs = undefined;
    }

    private scheduleApplyEventDispatchSettings(): void {
        // Debounce to avoid rapid apply loops while editing multi-select.
        this.dispatchEventsApplySeq++;
        const seq = this.dispatchEventsApplySeq;

        if (this.dispatchEventsApplyTimer) {
            clearTimeout(this.dispatchEventsApplyTimer);
        }

        this.dispatchEventsApplyTimer = setTimeout(() => {
            // Fire-and-forget; never block settings UI.
            this.applyEventDispatchSettings().catch((e) => {
                // Only log once per debounce window.
                if (seq === this.dispatchEventsApplySeq) {
                    this.getLogger().warn('Failed to apply Dispatch Events setting', e);
                }
            });
        }, 300);
    }

    async takeSnapshotInternal(timeout?: number) {
        this.markActivity();
        return this.withBaichuanRetry(async () => {
            try {
                const now = Date.now();
                const client = await this.ensureClient();
                const snapshotBuffer = await client.getSnapshot();
                const mo = await this.createMediaObject(snapshotBuffer, 'image/jpeg');
                this.lastB64Snapshot = await moToB64(mo);
                this.lastSnapshotTaken = now;

                return mo;
            } catch (e) {
                this.getLogger().error('Error taking snapshot', e);
                throw e;
            }
        });
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [];
    }

    getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    async takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        const isBattery = this.hasBattery();
        const now = Date.now();
        const logger = this.getLogger();

        const isMaxTimePassed = !this.lastSnapshotTaken || ((now - this.lastSnapshotTaken) > 1000 * 60 * 60);
        const isBatteryTimePassed = !this.lastSnapshotTaken || ((now - this.lastSnapshotTaken) > 1000 * 15);
        let canTake = false;

        if (!this.lastB64Snapshot || !this.lastSnapshotTaken) {
            logger.log('Allowing new snapshot because not taken yet');
            canTake = true;
        } else if (this.sleeping && isMaxTimePassed) {
            logger.log('Allowing new snapshot while sleeping because older than 1 hour');
            canTake = true;
        } else if (!this.sleeping && isBattery && isBatteryTimePassed) {
            logger.log('Allowing new snapshot because older than 15 seconds');
            canTake = true;
        } else {
            canTake = true;
        }

        if (canTake) {
            return this.takeSnapshotInternal(options?.timeout);
        } else if (this.lastB64Snapshot) {
            const mo = await b64ToMo(this.lastB64Snapshot);

            return mo;
        } else {
            return null;
        }
    }

    getRtspChannel(): number {
        const channel = this.storageSettings.values.rtspChannel;
        return channel !== undefined ? Number(channel) : 0;
    }


    async getVideoStream(vso: RequestMediaStreamOptions): Promise<MediaObject> {
        this.markActivity();
        if (!vso)
            throw new Error('video streams not set up or no longer exists.');

        const vsos = await this.getVideoStreamOptions();
        const selected = vsos?.find(s => s.id === vso.id) || vsos?.[0];
        if (!selected)
            throw new Error('No stream options available');

        const profile = parseStreamProfileFromId(selected.id) || 'main';

        return this.withBaichuanRetry(async () => {
            const channel = this.getRtspChannel();
            const streamKey = `${channel}_${profile}`;

            const expectedVideoType = selected?.video?.codec?.includes('265') ? 'H265'
                : selected?.video?.codec?.includes('264') ? 'H264'
                    : undefined;

            const { host, port, sdp, audio } = await this.streamManager.getRfcStream(channel, profile, streamKey, expectedVideoType as any);

            const { url: _ignoredUrl, ...mso }: any = selected;
            // This stream is delivered as RFC4571 (RTP over raw TCP), not RTSP.
            // Mark it accordingly to avoid RTSP-specific handling in downstream plugins.
            mso.container = 'rtp';
            if (audio) {
                mso.audio ||= {};
                mso.audio.codec = audio.codec;
                mso.audio.sampleRate = audio.sampleRate;
                (mso.audio as any).channels = audio.channels;
            }

            const rfc = {
                url: `tcp://${host}:${port}`,
                sdp,
                mediaStreamOptions: mso as ResponseMediaStreamOptions,
            };

            const jsonString = JSON.stringify(rfc);
            return await sdk.mediaManager.createMediaObject(
                Buffer.from(jsonString),
                'x-scrypted/x-rfc4571',
                {
                    sourceId: this.id,
                },
            );
        });
    }

    async getVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        this.markActivity();
        return this.withBaichuanRetry(async () => {
            const client = await this.ensureClient();
            const channel = this.storageSettings.values.rtspChannel;
            const streamMetadata = await client.getStreamMetadata(channel);

            const streams: UrlMediaStreamOptions[] = [];

            // Only return stable identifiers + codec info. RTSP server is ensured on-demand in createVideoStream.
            for (const stream of streamMetadata.streams) {
                const profile = stream.profile as StreamProfile;
                const codec = stream.videoEncType.includes('264') ? 'h264' : stream.videoEncType.includes('265') ? 'h265' : stream.videoEncType.toLowerCase();
                const id = profile === 'main'
                    ? 'mainstream'
                    : profile === 'sub'
                        ? 'substream'
                        : 'extstream';
                const name = profile === 'main'
                    ? 'Main Stream'
                    : profile === 'sub'
                        ? 'Substream'
                        : 'Ext Stream';

                streams.push({
                    name,
                    id,
                    // We return RFC4571 (RTP over TCP). Mark as RTP so other plugins do not attempt RTSP prebuffering.
                    container: 'rtp',
                    video: { codec, width: stream.width, height: stream.height },
                    url: ``,
                });
            }

            return streams;
        });
    }

    async getOtherSettings(): Promise<Setting[]> {
        return await this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: string) {
        await this.storageSettings.putSetting(key, value);
    }

    showRtspUrlOverride() {
        return false;
    }

    async reportDevices() {
        const hasSiren = this.hasSiren();
        const hasFloodlight = this.hasFloodlight();
        const hasPirEvents = this.hasPirEvents();

        const devices: Device[] = [];

        if (hasSiren) {
            const sirenNativeId = `${this.nativeId}-siren`;
            const sirenDevice: Device = {
                providerNativeId: this.nativeId,
                name: `${this.name} Siren`,
                nativeId: sirenNativeId,
                info: {
                    ...this.info,
                },
                interfaces: [
                    ScryptedInterface.OnOff
                ],
                type: ScryptedDeviceType.Siren,
            };

            devices.push(sirenDevice);
        }

        if (hasFloodlight) {
            const floodlightNativeId = `${this.nativeId}-floodlight`;
            const floodlightDevice: Device = {
                providerNativeId: this.nativeId,
                name: `${this.name} Floodlight`,
                nativeId: floodlightNativeId,
                info: {
                    ...this.info,
                },
                interfaces: [
                    ScryptedInterface.OnOff
                ],
                type: ScryptedDeviceType.Light,
            };

            devices.push(floodlightDevice);
        }

        if (hasPirEvents) {
            const pirNativeId = `${this.nativeId}-pir`;
            const pirDevice: Device = {
                providerNativeId: this.nativeId,
                name: `${this.name} PIR sensor`,
                nativeId: pirNativeId,
                info: {
                    ...this.info,
                },
                interfaces: [
                    ScryptedInterface.OnOff
                ],
                type: ScryptedDeviceType.Switch,
            };

            devices.push(pirDevice);
        }

        sdk.deviceManager.onDevicesChanged({
            providerNativeId: this.nativeId,
            devices
        });
    }

    async getDevice(nativeId: string): Promise<any> {
        if (nativeId.endsWith('-siren')) {
            this.siren ||= new ReolinkCameraSiren(this, nativeId);
            return this.siren;
        } else if (nativeId.endsWith('-floodlight')) {
            this.floodlight ||= new ReolinkCameraFloodlight(this, nativeId);
            return this.floodlight;
        } else if (nativeId.endsWith('-pir')) {
            this.pirSensor ||= new ReolinkCameraPirSensor(this, nativeId);
            return this.pirSensor;
        }
    }

    async releaseDevice(id: string, nativeId: string) {
        if (nativeId.endsWith('-siren')) {
            delete this.siren;
        } else if (nativeId.endsWith('-floodlight')) {
            delete this.floodlight;
        } else if (nativeId.endsWith('-pir')) {
            delete this.pirSensor;
        }
    }

    async startIntercom(media: MediaObject): Promise<void> {
        await this.intercom.start(media);
    }

    stopIntercom(): Promise<void> {
        return this.intercom.stop();
    }
}