import type { DebugOptions, DeviceCapabilities, PtzCommand, ReolinkBaichuanApi, StreamProfile } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { BinarySensor, Brightness, Camera, Device, DeviceProvider, Intercom, MediaObject, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, OnOff, PanTiltZoom, PanTiltZoomCommand, RequestMediaStreamOptions, RequestPictureOptions, ResponseMediaStreamOptions, ResponsePictureOptions, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, VideoCamera, VideoTextOverlay, VideoTextOverlays } from "@scrypted/sdk";
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { UrlMediaStreamOptions } from "../../scrypted/plugins/rtsp/src/rtsp";
import { createBaichuanApi } from './connect';
import { ReolinkBaichuanIntercom } from "./intercom";
import ReolinkNativePlugin from "./main";
import { ReolinkPtzPresets } from "./presets";
import {
    createRfc4571MediaObjectFromStreamManager,
    expectedVideoTypeFromUrlMediaStreamOptions,
    fetchVideoStreamOptionsFromApi,
    parseStreamProfileFromId,
    selectStreamOption,
    StreamManager,
} from './stream-utils';
import { getDeviceInterfaces } from "./utils";

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
        this.camera.getLogger().log(`Siren toggle: turnOff (device=${this.nativeId})`);
        this.on = false;
        try {
            await this.setSiren(false);
            this.camera.getLogger().log(`Siren toggle: turnOff ok (device=${this.nativeId})`);
        }
        catch (e) {
            this.camera.getLogger().warn(`Siren toggle: turnOff failed (device=${this.nativeId})`, e);
            throw e;
        }
    }

    async turnOn() {
        this.camera.getLogger().log(`Siren toggle: turnOn (device=${this.nativeId})`);
        this.on = true;
        try {
            await this.setSiren(true);
            this.camera.getLogger().log(`Siren toggle: turnOn ok (device=${this.nativeId})`);
        }
        catch (e) {
            this.camera.getLogger().warn(`Siren toggle: turnOn failed (device=${this.nativeId})`, e);
            throw e;
        }
    }

    private async setSiren(on: boolean) {
        this.camera.markActivity();

        const channel = this.camera.getRtspChannel();
        await this.camera.withBaichuanRetry(async () => {
            const api = await this.camera.ensureClient();
            return await api.setSiren(channel, on);
        });
    }
}

class ReolinkCameraFloodlight extends ScryptedDeviceBase implements OnOff, Brightness {
    constructor(public camera: ReolinkNativeCamera, nativeId: string) {
        super(nativeId);
    }

    async setBrightness(brightness: number): Promise<void> {
        this.camera.getLogger().log(`Floodlight toggle: setBrightness (device=${this.nativeId} brightness=${brightness})`);
        this.brightness = brightness;
        try {
            await this.setFloodlight(undefined, brightness);
            this.camera.getLogger().log(`Floodlight toggle: setBrightness ok (device=${this.nativeId} brightness=${brightness})`);
        }
        catch (e) {
            this.camera.getLogger().warn(`Floodlight toggle: setBrightness failed (device=${this.nativeId} brightness=${brightness})`, e);
            throw e;
        }
    }

    async turnOff() {
        this.camera.getLogger().log(`Floodlight toggle: turnOff (device=${this.nativeId})`);
        this.on = false;
        try {
            await this.setFloodlight(false);
            this.camera.getLogger().log(`Floodlight toggle: turnOff ok (device=${this.nativeId})`);
        }
        catch (e) {
            this.camera.getLogger().warn(`Floodlight toggle: turnOff failed (device=${this.nativeId})`, e);
            throw e;
        }
    }

    async turnOn() {
        this.camera.getLogger().log(`Floodlight toggle: turnOn (device=${this.nativeId})`);
        this.on = true;
        try {
            await this.setFloodlight(true);
            this.camera.getLogger().log(`Floodlight toggle: turnOn ok (device=${this.nativeId})`);
        }
        catch (e) {
            this.camera.getLogger().warn(`Floodlight toggle: turnOn failed (device=${this.nativeId})`, e);
            throw e;
        }
    }

    private async setFloodlight(on?: boolean, brightness?: number) {
        this.camera.markActivity();

        const channel = this.camera.getRtspChannel();
        await this.camera.withBaichuanRetry(async () => {
            const api = await this.camera.ensureClient();
            return await api.setWhiteLedState(channel, on, brightness);
        });
    }
}

export class ReolinkNativeCamera extends ScryptedDeviceBase implements VideoCamera, Settings, Camera, DeviceProvider, Intercom, ObjectDetector, PanTiltZoom, VideoTextOverlays, BinarySensor {
    videoStreamOptions: Promise<UrlMediaStreamOptions[]>;
    motionTimeout: NodeJS.Timeout;
    private doorbellBinaryTimeout: NodeJS.Timeout | undefined;
    siren: ReolinkCameraSiren;
    floodlight: ReolinkCameraFloodlight;
    private baichuanApi: ReolinkBaichuanApi | undefined;
    private ensureClientPromise: Promise<ReolinkBaichuanApi> | undefined;
    private connectionTime: number | undefined;
    private refreshingState = false;

    private periodicStarted = false;
    private statusPollTimer: NodeJS.Timeout | undefined;
    private lastActivityMs = Date.now();
    private streamManager: StreamManager;

    private intercom: ReolinkBaichuanIntercom;

    private ptzPresets: ReolinkPtzPresets;

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
                await this.subscribeToEvents();
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
            choices: ['enabled', 'debugRtsp', 'traceStream', 'traceTalk', 'traceEvents', 'debugH264', 'debugParamSets', 'eventLogs'],
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
            group: 'PTZ',
            title: 'Presets to enable',
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
        ptzMoveDurationMs: {
            title: 'PTZ Move Duration (ms)',
            description: 'How long a PTZ command moves before sending stop. Higher = more movement per click.',
            type: 'number',
            defaultValue: 300,
            group: 'PTZ',
        },
        ptzZoomStep: {
            group: 'PTZ',
            title: 'PTZ Zoom Step',
            description: 'How much to change zoom per zoom command (in zoom factor units, where 1.0 is normal).',
            type: 'number',
            defaultValue: 0.1,
        },
        ptzCreatePreset: {
            group: 'PTZ',
            title: 'Create Preset',
            description: 'Enter a name and press Save to create a new PTZ preset at the current position.',
            type: 'string',
            placeholder: 'e.g. Door',
            defaultValue: '',
            onPut: async (_ov, value) => {
                const name = String(value ?? '').trim();
                if (!name) {
                    // Cleanup if user saved whitespace.
                    if (String(value ?? '') !== '') {
                        await this.storageSettings.putSetting('ptzCreatePreset', '');
                    }
                    return;
                }

                this.markActivity();
                const logger = this.getLogger();
                logger.log(`PTZ presets: create preset requested (name=${name})`);

                const preset = await this.withBaichuanRetry(async () => {
                    await this.ensureClient();
                    return await this.ptzPresets.createPtzPreset(name);
                });
                const selection = `${preset.id}=${preset.name}`;

                // Auto-select created preset.
                await this.storageSettings.putSetting('ptzSelectedPreset', selection);
                // Cleanup input field.
                await this.storageSettings.putSetting('ptzCreatePreset', '');

                logger.log(`PTZ presets: created preset id=${preset.id} name=${preset.name}`);
            },
        },
        ptzSelectedPreset: {
            group: 'PTZ',
            title: 'Selected Preset',
            description: 'Select the preset to update or delete. Format: "id=name".',
            type: 'string',
            combobox: false,
            immediate: true,
        },
        ptzUpdateSelectedPreset: {
            group: 'PTZ',
            title: 'Update Selected Preset Position',
            description: 'Overwrite the selected preset with the current PTZ position.',
            type: 'button',
            immediate: true,
            onPut: async () => {
                const presetId = this.getSelectedPresetId();
                if (presetId === undefined) {
                    throw new Error('No preset selected');
                }

                this.markActivity();
                const logger = this.getLogger();
                logger.log(`PTZ presets: update position requested (presetId=${presetId})`);

                await this.withBaichuanRetry(async () => {
                    await this.ensureClient();
                    return await this.ptzPresets.updatePtzPresetToCurrentPosition(presetId);
                });
                logger.log(`PTZ presets: update position ok (presetId=${presetId})`);
            },
        },
        ptzDeleteSelectedPreset: {
            group: 'PTZ',
            title: 'Delete Selected Preset',
            description: 'Delete the selected preset (firmware dependent).',
            type: 'button',
            immediate: true,
            onPut: async () => {
                const presetId = this.getSelectedPresetId();
                if (presetId === undefined) {
                    throw new Error('No preset selected');
                }

                this.markActivity();
                const logger = this.getLogger();
                logger.log(`PTZ presets: delete requested (presetId=${presetId})`);

                await this.withBaichuanRetry(async () => {
                    await this.ensureClient();
                    return await this.ptzPresets.deletePtzPreset(presetId);
                });

                // If we deleted the selected preset, clear selection.
                await this.storageSettings.putSetting('ptzSelectedPreset', '');
                logger.log(`PTZ presets: delete ok (presetId=${presetId})`);
            },
        },
        cachedPresets: {
            multiple: true,
            hide: true,
            json: true,
            defaultValue: [],
        },
        cachedOsd: {
            multiple: true,
            hide: true,
            json: true,
            defaultValue: [],
        },
        intercomBlocksPerPayload: {
            subgroup: 'Advanced',
            title: 'Intercom Blocks Per Payload',
            description: 'Lower reduces latency (more packets). Typical: 1-4. Requires restarting talk session to take effect.',
            type: 'number',
            defaultValue: 1,
        },
    });

    constructor(nativeId: string, public plugin: ReolinkNativePlugin) {
        super(nativeId);

        this.streamManager = new StreamManager({
            createStreamClient: () => this.createStreamClient(),
            getLogger: () => this.getLogger(),
        });

        this.intercom = new ReolinkBaichuanIntercom(this);
        this.ptzPresets = new ReolinkPtzPresets(this);

        this.storageSettings.settings.presets.onGet = async () => {
            const choices = this.storageSettings.values.cachedPresets.map((preset) => preset.id + '=' + preset.name);
            return {
                choices,
            };
        };

        this.storageSettings.settings.ptzSelectedPreset.onGet = async () => {
            const choices = (this.storageSettings.values.cachedPresets || []).map((preset) => preset.id + '=' + preset.name);
            return { choices };
        };

        setTimeout(async () => {
            await this.init();
        }, 2000);
    }

    private getSelectedPresetId(): number | undefined {
        const s = this.storageSettings.values.ptzSelectedPreset;
        if (!s) return undefined;

        const idPart = s.includes('=') ? s.split('=')[0] : s;
        const id = Number(idPart);
        return Number.isFinite(id) ? id : undefined;
    }

    private isRecoverableBaichuanError(e: any): boolean {
        const message = e?.message || e?.toString?.() || '';
        return typeof message === 'string' && (
            message.includes('Baichuan socket closed') ||
            message.includes('Baichuan UDP stream closed') ||
            message.includes('socket hang up') ||
            message.includes('ECONNRESET') ||
            message.includes('EPIPE')
        );
    }

    private async resetBaichuanClient(reason?: any): Promise<void> {
        try {
            this.unsubscribedToEvents();
            await this.baichuanApi?.close();
        }
        catch (e) {
            this.getLogger().warn('Error closing Baichuan client during reset', e);
        }
        finally {
            this.baichuanApi = undefined;
            this.connectionTime = undefined;
            this.ensureClientPromise = undefined;
            if (this.passiveRefreshTimer) {
                clearTimeout(this.passiveRefreshTimer);
                this.passiveRefreshTimer = undefined;
            }
        }

        if (reason) {
            const message = reason?.message || reason?.toString?.() || reason;
            this.getLogger().warn(`Baichuan client reset requested: ${message}`);
        }
    }

    async withBaichuanRetry<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        }
        catch (e) {
            if (!this.isRecoverableBaichuanError(e)) {
                throw e;
            }

            await this.resetBaichuanClient(e);
            // Important: callers must re-acquire the client inside fn.
            return await fn();
        }
    }

    public getLogger() {
        return this.console;
    }

    async init() {
        const logger = this.getLogger();

        // At init it's OK to wake the camera to fetch full capabilities/state.
        // If this fails (offline camera), continue device setup and rely on later activity.
        try {
            await this.ensureClient();
            await this.refreshDeviceState();
        }
        catch (e) {
            logger.warn('Failed to connect/refresh during init', e);
        }

        await this.reportDevices();
        this.updateDeviceInfo();
        this.updatePtzCaps();

        // Start event subscription after discovery.
        try {
            await this.subscribeToEvents();
        }
        catch (e) {
            logger.warn('Failed to subscribe to Baichuan events', e);
        }

        // Periodic status refresh + event resubscribe.
        this.startPeriodicTasks();
    }

    async ensureClient(): Promise<ReolinkBaichuanApi> {
        // Always open a fresh main session. Do not persist/reuse old sessions, which can go stale
        // and cause streaming to stop receiving frames.

        // Prevent concurrent login storms. Multiple callers may race here and otherwise create
        // multiple Baichuan sessions in parallel.
        if (this.ensureClientPromise) return await this.ensureClientPromise;

        this.ensureClientPromise = (async () => {
            const { ipAddress, username, password } = this.storageSettings.values;

            if (!ipAddress || !username || !password) {
                throw new Error('Missing camera credentials');
            }

            // Tear down any previous session to avoid persisting stale logins.
            if (this.baichuanApi) {
                try {
                    this.baichuanApi.offSimpleEvent(this.onSimpleEvent);
                }
                catch {
                    // ignore
                }

                try {
                    await this.baichuanApi.close();
                }
                catch {
                    // ignore
                }
            }

            const debugOptions = this.getBaichuanDebugOptions();

            const api = await createBaichuanApi(
                {
                    host: ipAddress,
                    username,
                    password,
                    logger: this.console,
                    ...(debugOptions ? { debugOptions } : {}),
                },
                'tcp',
            );
            await api.login();
            this.baichuanApi = api;
            this.connectionTime = Date.now();

            // Re-attach event handler if enabled.
            if (this.isEventDispatchEnabled()) {
                try {
                    api.onSimpleEvent(this.onSimpleEvent);
                }
                catch {
                    // ignore
                }
            }
            return api;
        })();

        try {
            return await this.ensureClientPromise;
        }
        finally {
            // Allow future reconnects (e.g. after close/reset) and avoid pinning rejected promises.
            this.ensureClientPromise = undefined;
        }
    }

    private getBaichuanDebugOptions(): any | undefined {
        const sel = new Set<string>(this.storageSettings.values.debugLogs);
        if (!sel.size) return undefined;

        const debugOptions: DebugOptions = {};
        // Only pass through Baichuan client debug flags.
        const clientKeys = new Set(['enabled', 'debugRtsp', 'traceStream', 'traceTalk', 'traceEvents', 'debugH264', 'debugParamSets']);
        for (const k of sel) {
            if (!clientKeys.has(k)) continue;
            debugOptions[k] = true;
        }
        return Object.keys(debugOptions).length ? debugOptions : undefined;
    }

    private async createStreamClient(): Promise<ReolinkBaichuanApi> {
        const { ipAddress, username, password } = this.storageSettings.values;
        if (!ipAddress || !username || !password) {
            throw new Error('Missing camera credentials');
        }

        const debugOptions = this.getBaichuanDebugOptions();
        const api = await createBaichuanApi(
            {
                host: ipAddress,
                username,
                password,
                logger: this.console,
                ...(debugOptions ? { debugOptions } : {}),
            },
            'tcp',
        );
        await api.login();

        return api;
    }

    getClient(): ReolinkBaichuanApi | undefined {
        return this.baichuanApi;
    }

    private async refreshDeviceState(): Promise<void> {
        if (this.refreshingState) {
            return;
        }
        this.refreshingState = true;

        const logger = this.getLogger();
        const api = await this.ensureClient();
        const channel = this.getRtspChannel();

        try {
            const { capabilities, abilities, support, presets } = await this.withBaichuanRetry(async () => {
                const api = await this.ensureClient();
                return await api.getDeviceCapabilities(channel, {
                    probeAi: false,
                });
            });
            this.storageSettings.values.capabilities = capabilities;
            this.ptzPresets.setCachedPtzPresets(presets);


            try {
                const { interfaces, type } = getDeviceInterfaces({
                    capabilities,
                    logger: this.console,
                });

                const device: Device = {
                    nativeId: this.nativeId,
                    providerNativeId: this.plugin.nativeId,
                    name: this.name,
                    interfaces,
                    type,
                    info: this.info,
                };

                logger.log(`Updating device interfaces: ${JSON.stringify(interfaces)}`);

                await sdk.deviceManager.onDeviceDiscovered(device);
            } catch (e) {
                logger.error('Failed to update device interfaces', e);
            }

            this.console.log(`Refreshed device capabilities: ${JSON.stringify({ capabilities, abilities, support, presets })}`);
        }
        catch (e) {
            logger.error('Failed to refresh abilities', e);
        }

        try {
            await this.refreshAuxDevicesStatus();
        }
        catch (e) {
            logger.error('Failed to refresh device status', e);
        }

        this.refreshingState = false;
    }

    private onSimpleEvent = (ev: any) => {
        try {
            if (!this.isEventDispatchEnabled()) return;
            if (this.storageSettings.values.dispatchEvents.includes('eventLogs')) {
                this.getLogger().debug(`Baichuan event: ${JSON.stringify(ev)}`);
            }

            const channel = this.getRtspChannel();
            if (ev?.channel !== undefined && ev.channel !== channel) return;

            const objects: string[] = [];
            let motion = false;

            switch (ev?.type) {
                case 'motion':
                    motion = true;
                    break;
                case 'doorbell':
                    if (!this.doorbellBinaryTimeout) {
                        this.binaryState = true;
                        this.doorbellBinaryTimeout = setTimeout(() => {
                            this.binaryState = false;
                            this.doorbellBinaryTimeout = undefined;
                        }, 5000);
                    }

                    motion = true;
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
    }

    private passiveRefreshTimer: ReturnType<typeof setTimeout> | undefined;

    private cachedVideoStreamOptions: UrlMediaStreamOptions[] | undefined;

    private unsubscribedToEvents() {
        const api = this.getClient();
        if (!api) return;
        try {
            api.offSimpleEvent(this.onSimpleEvent);
        }
        catch {
            // ignore
        }
    }

    private async subscribeToEvents(): Promise<void> {
        const logger = this.getLogger();
        const selection = Array.from(this.getDispatchEventsSelection()).sort();
        const enabled = selection.length > 0;

        // Settings change / init counts as activity.
        this.markActivity();

        if (!this.shouldDispatchMotion()) {
            if (this.motionTimeout) clearTimeout(this.motionTimeout);
            this.motionDetected = false;
        }

        this.unsubscribedToEvents();

        if (!enabled) {
            if (this.doorbellBinaryTimeout) {
                clearTimeout(this.doorbellBinaryTimeout);
                this.doorbellBinaryTimeout = undefined;
            }
            this.binaryState = false;
            return;
        }

        const api = await this.ensureClient();

        try {
            api.onSimpleEvent(this.onSimpleEvent);
            logger.log(`Subscribed to events (${selection.join(', ')})`);
        }
        catch (e) {
            logger.warn('Failed to attach Baichuan event handler', e);
            return;
        }
    }

    markActivity(): void {
        this.lastActivityMs = Date.now();
    }

    async release() {
        this.statusPollTimer && clearInterval(this.statusPollTimer);
        if (this.passiveRefreshTimer) {
            clearTimeout(this.passiveRefreshTimer);
            this.passiveRefreshTimer = undefined;
        }
        return this.resetBaichuanClient();
    }

    private startPeriodicTasks(): void {
        if (this.periodicStarted) return;
        this.periodicStarted = true;

        this.statusPollTimer = setInterval(() => {
            this.periodic10sTick().catch(() => { });
        }, 10_000);
    }

    private async periodic10sTick(): Promise<void> {
        await this.ensureClient();
        await this.refreshAuxDevicesStatus();
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
    }

    async getVideoTextOverlays(): Promise<Record<string, VideoTextOverlay>> {
        const client = await this.ensureClient();
        const channel = this.getRtspChannel();

        let osd = this.storageSettings.values.cachedOsd;

        if (!osd.length) {
            osd = await client.getOsd(channel);
            this.storageSettings.values.cachedOsd = osd;
        }

        return {
            osdChannel: {
                text: osd?.osdChannel?.enable ? osd.osdChannel.name : undefined,
            },
            osdTime: {
                text: !!osd?.osdTime?.enable,
                readonly: true,
            },
        };
    }

    async setVideoTextOverlay(id: 'osdChannel' | 'osdTime', value: VideoTextOverlay): Promise<void> {
        const client = await this.ensureClient();
        const channel = this.getRtspChannel();

        const osd = await client.getOsd(channel);

        if (id === 'osdChannel') {
            const nextName = typeof value?.text === 'string' ? value.text.trim() : '';
            const enable = !!nextName || value?.text === true;
            osd.osdChannel.enable = enable ? 1 : 0;
            // Name must always be valid when enabled.
            if (enable) {
                osd.osdChannel.name = nextName || osd.osdChannel.name || this.name || 'Camera';
            }
        }
        else if (id === 'osdTime') {
            osd.osdTime.enable = value?.text ? 1 : 0;
        }
        else {
            throw new Error('unknown overlay: ' + id);
        }

        await client.setOsd(channel, osd);
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

        // Preset navigation.
        const preset = command.preset;
        if (preset !== undefined && preset !== null) {
            const presetId = Number(preset);
            if (!Number.isFinite(presetId)) {
                this.getLogger().warn(`Invalid PTZ preset id: ${preset}`);
                return;
            }
            await this.ptzPresets.moveToPreset(presetId);
            return;
        }

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
            // const client = await this.ensureClient();
            // const ai = await client.getAiState();

            const classes: string[] = [];
            classes.push('people', 'vehicle', 'dog_cat', 'face', 'package')
            // AI state structure may vary, check if it's an object with support field
            // if (ai && typeof ai === 'object' && 'support' in ai) {
            //     if (ai.support) {
            //         // Add common AI types if supported
            //         classes.push('people', 'vehicle', 'dog_cat', 'face', 'package');
            //     }
            // }

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

    hasIntercom() {
        const capabilities = this.getAbilities();
        return Boolean(capabilities?.hasIntercom);
    }

    isDoorbell() {
        const capabilities = this.getAbilities() as any;
        return Boolean(capabilities?.isDoorbell);
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

        if (this.storageSettings.values.dispatchEvents.includes('eventLogs')) {
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

    async takePicture(options?: RequestPictureOptions) {
        this.markActivity();
        return this.withBaichuanRetry(async () => {
            try {
                const client = await this.ensureClient();
                const snapshotBuffer = await client.getSnapshot();
                const mo = await this.createMediaObject(snapshotBuffer, 'image/jpeg');

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

    getRtspChannel(): number {
        const channel = this.storageSettings.values.rtspChannel;
        return channel !== undefined ? Number(channel) : 0;
    }


    async getVideoStream(vso: RequestMediaStreamOptions): Promise<MediaObject> {
        this.markActivity();
        const vsos = await this.getVideoStreamOptions();
        const selected = selectStreamOption(vsos, vso);
        this.getLogger().log(`Creating video stream for option id=${selected.id} name=${selected.name}`);

        const profile = parseStreamProfileFromId(selected.id) || 'main';

        return this.withBaichuanRetry(async () => {
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
                    const id = profile === 'main' ? 'mainstream' : profile === 'sub' ? 'substream' : 'extstream';
                    const name = profile === 'main' ? 'Main Stream' : profile === 'sub' ? 'Sub Stream' : 'Ext Stream';

                    const prev = this.cachedVideoStreamOptions ?? [];
                    const next = prev.filter((s) => s.id !== id);
                    next.push({ name, id, container: 'rtp', video: { codec: detectedCodec }, url: `` });
                    this.cachedVideoStreamOptions = next;
                },
            });
        });
    }

    async getVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        this.markActivity();
        return this.withBaichuanRetry(async () => {
            const client = await this.ensureClient();
            const channel = this.storageSettings.values.rtspChannel;
            const streams = await fetchVideoStreamOptionsFromApi(client, channel);
            this.cachedVideoStreamOptions = streams;
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
        }
    }

    async releaseDevice(id: string, nativeId: string) {
        if (nativeId.endsWith('-siren')) {
            delete this.siren;
        } else if (nativeId.endsWith('-floodlight')) {
            delete this.floodlight;
        }
    }

    async startIntercom(media: MediaObject): Promise<void> {
        await this.intercom.start(media);
    }

    stopIntercom(): Promise<void> {
        return this.intercom.stop();
    }
}