import type { DeviceCapabilities, PtzCommand, PtzPreset, ReolinkBaichuanApi, ReolinkSimpleEvent } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { BinarySensor, Brightness, Camera, Device, DeviceProvider, Intercom, MediaObject, MediaStreamUrl, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, OnOff, PanTiltZoom, PanTiltZoomCommand, RequestMediaStreamOptions, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, VideoCamera, VideoTextOverlay, VideoTextOverlays } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import type { UrlMediaStreamOptions } from "../../scrypted/plugins/rtsp/src/rtsp";
import { createBaichuanApi, normalizeUid, type BaichuanTransport } from "./connect";
import { ReolinkBaichuanIntercom } from "./intercom";
import ReolinkNativePlugin from "./main";
import { ReolinkPtzPresets } from "./presets";
import {
    buildVideoStreamOptionsFromRtspRtmp,
    createRfc4571MediaObjectFromStreamManager,
    expectedVideoTypeFromUrlMediaStreamOptions,
    fetchVideoStreamOptionsFromApi,
    isNativeStreamId,
    parseStreamProfileFromId,
    selectStreamOption,
    StreamManager,
} from "./stream-utils";
import { getDeviceInterfaces } from "./utils";

export type CameraType = 'battery' | 'regular';

export interface CommonCameraMixinOptions {
    type: CameraType;
}

class ReolinkCameraSiren extends ScryptedDeviceBase implements OnOff {
    constructor(public camera: CommonCameraMixin, nativeId: string) {
        super(nativeId);
    }

    async turnOff(): Promise<void> {
        this.camera.getLogger().log(`Siren toggle: turnOff (device=${this.nativeId})`);
        this.on = false;
        try {
            await this.camera.setSirenEnabled(false);
            this.camera.getLogger().log(`Siren toggle: turnOff ok (device=${this.nativeId})`);
        }
        catch (e) {
            this.camera.getLogger().warn(`Siren toggle: turnOff failed (device=${this.nativeId})`, e);
            throw e;
        }
    }

    async turnOn(): Promise<void> {
        this.camera.getLogger().log(`Siren toggle: turnOn (device=${this.nativeId})`);
        this.on = true;
        try {
            await this.camera.setSirenEnabled(true);
            this.camera.getLogger().log(`Siren toggle: turnOn ok (device=${this.nativeId})`);
        }
        catch (e) {
            this.camera.getLogger().warn(`Siren toggle: turnOn failed (device=${this.nativeId})`, e);
            throw e;
        }
    }
}

class ReolinkCameraFloodlight extends ScryptedDeviceBase implements OnOff, Brightness {
    constructor(public camera: CommonCameraMixin, nativeId: string) {
        super(nativeId);
    }

    async setBrightness(brightness: number): Promise<void> {
        this.camera.getLogger().log(`Floodlight toggle: setBrightness (device=${this.nativeId} brightness=${brightness})`);
        this.brightness = brightness;
        try {
            await this.camera.setFloodlightState(undefined, brightness);
            this.camera.getLogger().log(`Floodlight toggle: setBrightness ok (device=${this.nativeId} brightness=${brightness})`);
        }
        catch (e) {
            this.camera.getLogger().warn(`Floodlight toggle: setBrightness failed (device=${this.nativeId} brightness=${brightness})`, e);
            throw e;
        }
    }

    async turnOff(): Promise<void> {
        this.camera.getLogger().log(`Floodlight toggle: turnOff (device=${this.nativeId})`);
        this.on = false;
        try {
            await this.camera.setFloodlightState(false);
            this.camera.getLogger().log(`Floodlight toggle: turnOff ok (device=${this.nativeId})`);
        }
        catch (e) {
            this.camera.getLogger().warn(`Floodlight toggle: turnOff failed (device=${this.nativeId})`, e);
            throw e;
        }
    }

    async turnOn(): Promise<void> {
        this.camera.getLogger().log(`Floodlight toggle: turnOn (device=${this.nativeId})`);
        this.on = true;
        try {
            await this.camera.setFloodlightState(true);
            this.camera.getLogger().log(`Floodlight toggle: turnOn ok (device=${this.nativeId})`);
        }
        catch (e) {
            this.camera.getLogger().warn(`Floodlight toggle: turnOn failed (device=${this.nativeId})`, e);
            throw e;
        }
    }
}

class ReolinkCameraPirSensor extends ScryptedDeviceBase implements OnOff {
    constructor(public camera: CommonCameraMixin, nativeId: string) {
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

export abstract class CommonCameraMixin extends ScryptedDeviceBase implements VideoCamera, Camera, Settings, DeviceProvider, ObjectDetector, PanTiltZoom, VideoTextOverlays, BinarySensor, Intercom {
    storageSettings = new StorageSettings(this, {
        // Basic connection settings
        ipAddress: {
            title: 'IP Address',
            type: 'string',
            onPut: async () => {
                await this.credentialsChanged();
            }
        },
        username: {
            type: 'string',
            title: 'Username',
            onPut: async () => {
                await this.credentialsChanged();
            }
        },
        password: {
            type: 'password',
            title: 'Password',
            onPut: async () => {
                await this.credentialsChanged();
            }
        },
        rtspChannel: {
            type: 'number',
            hide: true,
            defaultValue: 0,
        },
        capabilities: {
            json: true,
            hide: true,
        },
        // Battery camera specific
        uid: {
            title: 'UID',
            description: 'Reolink UID (required for battery cameras / BCUDP).',
            type: 'string',
            hide: true,
            onPut: async () => {
                await this.credentialsChanged();
            }
        },
        mixinsSetup: {
            type: 'boolean',
            hide: true,
        },
        snapshotCacheMinutes: {
            title: "Snapshot Cache Minutes",
            group: 'Advanced',
            description: "Return a cached snapshot if taken within the last N minutes.",
            type: "number",
            defaultValue: 5,
            hide: true,
        },
        // Regular camera specific
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
                if (changed && this.resetBaichuanClient) {
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
        // PTZ Presets
        presets: {
            group: 'PTZ',
            title: 'Presets to enable',
            description: 'PTZ Presets in the format "id=name". Where id is the PTZ Preset identifier and name is a friendly name.',
            multiple: true,
            defaultValue: [],
            combobox: true,
            hide: true, // Will be shown if PTZ is supported
            onPut: async (ov, presets: string[]) => {
                const caps = {
                    ...(this.ptzCapabilities || {}),
                    presets: {},
                };
                for (const preset of presets) {
                    const [key, name] = preset.split('=');
                    caps.presets![key] = name;
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
            hide: true,
        },
        ptzZoomStep: {
            group: 'PTZ',
            title: 'PTZ Zoom Step',
            description: 'How much to change zoom per zoom command (in zoom factor units, where 1.0 is normal).',
            type: 'number',
            defaultValue: 0.1,
            hide: true,
        },
        ptzCreatePreset: {
            group: 'PTZ',
            title: 'Create Preset',
            description: 'Enter a name and press Save to create a new PTZ preset at the current position.',
            type: 'string',
            placeholder: 'e.g. Door',
            defaultValue: '',
            hide: true,
            onPut: async (_ov, value) => {
                const name = String(value ?? '').trim();
                if (!name) {
                    // Cleanup if user saved whitespace.
                    if (String(value ?? '') !== '') {
                        this.storageSettings.values.ptzCreatePreset = '';
                    }
                    return;
                }

                const logger = this.getLogger();
                logger.log(`PTZ presets: create preset requested (name=${name})`);

                const preset = await (this.withBaichuanRetry || (async (fn: () => Promise<any>) => fn()))(async () => {
                    await this.ensureClient();
                    if (!this.ptzPresets) {
                        throw new Error('PTZ presets not available');
                    }
                    return await this.ptzPresets.createPtzPreset(name);
                });
                const selection = `${preset.id}=${preset.name}`;

                // Auto-select created preset.
                this.storageSettings.values.ptzSelectedPreset = selection;
                this.storageSettings.values.ptzCreatePreset = '';

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
            hide: true,
        },
        ptzUpdateSelectedPreset: {
            group: 'PTZ',
            title: 'Update Selected Preset Position',
            description: 'Overwrite the selected preset with the current PTZ position.',
            type: 'button',
            immediate: true,
            hide: true,
            onPut: async () => {
                const presetId = this.getSelectedPresetId();
                if (presetId === undefined) {
                    throw new Error('No preset selected');
                }

                const logger = this.getLogger();
                logger.log(`PTZ presets: update position requested (presetId=${presetId})`);

                await (this.withBaichuanRetry || (async (fn: () => Promise<any>) => fn()))(async () => {
                    await this.ensureClient();
                    return await (this.ptzPresets).updatePtzPresetToCurrentPosition(presetId);
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
            hide: true,
            onPut: async () => {
                const presetId = this.getSelectedPresetId();
                if (presetId === undefined) {
                    throw new Error('No preset selected');
                }

                const logger = this.getLogger();
                logger.log(`PTZ presets: delete requested (presetId=${presetId})`);

                await (this.withBaichuanRetry || (async (fn: () => Promise<any>) => fn()))(async () => {
                    await this.ensureClient();
                    return await (this.ptzPresets).deletePtzPreset(presetId);
                });

                this.storageSettings.values.ptzSelectedPreset = '';
                logger.log(`PTZ presets: delete ok (presetId=${presetId})`);
            },
        },
    });

    ptzPresets = new ReolinkPtzPresets(this);
    refreshingState = false;
    classes: string[] = [];
    presets: PtzPreset[] = [];
    streamManager?: StreamManager;
    intercom?: ReolinkBaichuanIntercom;

    // Auxiliary device instances
    siren?: ReolinkCameraSiren;
    floodlight?: ReolinkCameraFloodlight;
    pirSensor?: ReolinkCameraPirSensor;

    // Video stream properties
    protected cachedVideoStreamOptions?: UrlMediaStreamOptions[];
    protected fetchingStreams = false;
    protected cachedNetPort?: { rtsp?: { port?: number; enable?: number }; rtmp?: { port?: number; enable?: number } };
    protected lastNetPortCacheAttempt: number = 0;
    protected netPortCacheBackoffMs: number = 5000; // 5 seconds backoff on failure

    // Client management
    protected baichuanApi: ReolinkBaichuanApi | undefined;
    protected ensureClientPromise: Promise<ReolinkBaichuanApi> | undefined;
    protected connectionTime: number | undefined;
    protected readonly protocol: BaichuanTransport;

    // Abstract init method that subclasses must implement
    abstract init(): Promise<void>;

    withBaichuanRetry?<T>(fn: () => Promise<T>): Promise<T>;
    protected withBaichuanClient?<T>(fn: (api: ReolinkBaichuanApi) => Promise<T>): Promise<T>;
    motionTimeout?: NodeJS.Timeout;
    doorbellBinaryTimeout?: NodeJS.Timeout;
    initComplete?: boolean;
    getBaichuanDebugOptions?(): any;
    isRecoverableBaichuanError?(e: any): boolean;
    resetBaichuanClient?(reason?: any): Promise<void>;

    constructor(nativeId: string, public plugin: ReolinkNativePlugin, public options: CommonCameraMixinOptions) {
        super(nativeId);
        // Set protocol based on camera type
        this.protocol = options.type === 'battery' ? 'udp' : 'tcp';

        this.streamManager = new StreamManager({
            createStreamClient: () => this.createStreamClient(),
            getLogger: () => this.getLogger(),
        });

        setTimeout(async () => {
            await this.parentInit();
        }, 2000);
    }
    createStreamClient(): Promise<ReolinkBaichuanApi> {
        throw new Error("Method not implemented.");
    }

    // Common method implementations
    public getRtspChannel(): number {
        const channel = this.storageSettings.values.rtspChannel;
        return channel !== undefined ? Number(channel) : 0;
    }

    public getAbilities(): DeviceCapabilities {
        return this.storageSettings.values.capabilities;
    }

    getLogger(): Console {
        return this.console;
    }

    updatePtzCaps() {
        const { hasPan, hasTilt, hasZoom } = this.getAbilities();
        this.ptzCapabilities = {
            ...this.ptzCapabilities,
            pan: hasPan,
            tilt: hasTilt,
            zoom: hasZoom,
        }
    }

    // Event subscription methods
    unsubscribedToEvents(): void {
        const api = (this as any).baichuanApi;
        if (!api) return;
        try {
            api.offSimpleEvent(this.onSimpleEvent);
        }
        catch {
            // ignore
        }

        if (this.motionDetected) {
            this.motionDetected = false;
        }
    }

    onSimpleEvent = (ev: ReolinkSimpleEvent) => {
        try {
            const logger = this.getLogger();

            if (this.storageSettings.values.dispatchEvents.includes('eventLogs')) {
                logger.log(`Baichuan event: ${JSON.stringify(ev)}`);
            }

            if (!this.isEventDispatchEnabled()) return;

            const channel = this.getRtspChannel();
            if (ev?.channel !== undefined && ev.channel !== channel) return;

            const objects: string[] = [];
            let motion = false;

            switch (ev?.type) {
                case 'motion':
                    motion = true;
                    break;
                case 'doorbell':
                    this.handleDoorbellEvent();
                    motion = true;
                    break;
                case 'people':
                case 'vehicle':
                case 'animal':
                case 'face':
                case 'package':
                case 'other':
                    if (this.shouldDispatchObjects()) objects.push(ev.type);
                    motion = true;
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

    async subscribeToEvents(): Promise<void> {
        const logger = this.getLogger();
        const selection = Array.from(this.getDispatchEventsSelection?.() ?? new Set()).sort();
        const enabled = selection.length > 0;

        this.unsubscribedToEvents();

        const shouldDispatchMotion = selection.includes('motion');
        if (!shouldDispatchMotion) {
            if (this.motionTimeout) clearTimeout(this.motionTimeout);
            this.motionDetected = false;
        }

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
            await api.onSimpleEvent(this.onSimpleEvent);
            logger.log(`Subscribed to events (${selection.join(', ')})`);
        }
        catch (e) {
            logger.warn('Failed to attach Baichuan event handler', e);
            return;
        }
    }

    // VideoTextOverlays interface implementation
    async getVideoTextOverlays(): Promise<Record<string, VideoTextOverlay>> {
        const client = await this.ensureClient();
        const channel = this.getRtspChannel();

        let osd = this.storageSettings.values.cachedOsd;

        if (!osd?.length) {
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

    // PanTiltZoom interface implementation
    async ptzCommand(command: PanTiltZoomCommand): Promise<void> {
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
            if (this.ptzPresets) {
                await this.ptzPresets.moveToPreset(presetId);
            } else {
                this.getLogger().warn('PTZ presets not available');
            }
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
            if (!Number.isFinite(step) || step <= 0) {
                this.getLogger().warn('Invalid PTZ zoom step, using default 0.1');
                return;
            }

            // Get current zoom factor and apply step
            const info = await client.getZoomFocus(channel);
            if (!info?.zoom) {
                this.getLogger().warn('Zoom command requested but camera did not report zoom support.');
                return;
            }

            // In Baichuan API, 1000 == 1.0x.
            const curFactor = (info.zoom.curPos ?? 1000) / 1000;
            const minFactor = (info.zoom.minPos ?? 1000) / 1000;
            const maxFactor = (info.zoom.maxPos ?? 1000) / 1000;
            const stepFactor = step;

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

    // ObjectDetector interface implementation
    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        return {
            classes: this.classes,
        };
    }

    async getDetectionInput(detectionId: string, eventId?: any): Promise<MediaObject> {
        return null;
    }

    getDispatchEventsSelection(): Set<'motion' | 'objects'> {
        return new Set(this.storageSettings.values.dispatchEvents);
    }

    isEventDispatchEnabled(): boolean {
        return this.getDispatchEventsSelection().size > 0;
    }

    shouldDispatchMotion(): boolean {
        return this.getDispatchEventsSelection().has('motion');
    }

    shouldDispatchObjects(): boolean {
        return this.getDispatchEventsSelection().has('objects');
    }

    async processEvents(events: { motion?: boolean; objects?: string[] }): Promise<void> {
        const isEventDispatchEnabled = this.isEventDispatchEnabled?.() ?? true;
        if (!isEventDispatchEnabled) return;

        const dispatchEvents = this.getDispatchEventsSelection?.() ?? new Set(['motion', 'objects']);
        const shouldDispatchMotion = dispatchEvents.has('motion');
        const shouldDispatchObjects = dispatchEvents.has('objects');

        if (shouldDispatchMotion && events.motion !== undefined) {
            const motionDetected = events.motion;
            if (motionDetected !== this.motionDetected) {
                this.motionDetected = motionDetected;
                if (motionDetected) {
                    if (this.motionTimeout) clearTimeout(this.motionTimeout);
                    const timeout = (this.storageSettings.values.motionTimeout || 30) * 1000;
                    this.motionTimeout = setTimeout(() => {
                        this.motionDetected = false;
                    }, timeout);
                } else {
                    if (this.motionTimeout) clearTimeout(this.motionTimeout);
                }
            }
        }

        if (shouldDispatchObjects && events.objects?.length) {
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
            if (this.nativeId) {
                sdk.deviceManager.onDeviceEvent(this.nativeId, ScryptedInterface.ObjectDetector, od);
            }
        }
    }

    // BinarySensor interface implementation (for doorbell)
    handleDoorbellEvent(): void {
        if (!this.doorbellBinaryTimeout) {
            this.binaryState = true;
            this.doorbellBinaryTimeout = setTimeout(() => {
                this.binaryState = false;
                this.doorbellBinaryTimeout = undefined;
            }, 5000);
        }
    }

    clearDoorbellBinary(): void {
        if (this.doorbellBinaryTimeout) {
            clearTimeout(this.doorbellBinaryTimeout);
            this.doorbellBinaryTimeout = undefined;
        }
        this.binaryState = false;
    }

    // Report devices (siren, floodlight, PIR)
    async reportDevices(): Promise<void> {
        if (!this.nativeId || !this.name) {
            return;
        }

        const { hasSiren, hasFloodlight, hasPir } = this.getAbilities();

        const devices: Device[] = [];

        if (hasSiren) {
            const sirenNativeId = `${this.nativeId}-siren`;
            devices.push({
                providerNativeId: this.plugin?.nativeId,
                name: `${this.name} Siren`,
                nativeId: sirenNativeId,
                info: {
                    ...(this.info || {}),
                },
                interfaces: [ScryptedInterface.OnOff],
                type: ScryptedDeviceType.Siren,
            });
        }

        if (hasFloodlight) {
            const floodlightNativeId = `${this.nativeId}-floodlight`;
            devices.push({
                providerNativeId: this.plugin?.nativeId,
                name: `${this.name} Floodlight`,
                nativeId: floodlightNativeId,
                info: {
                    ...(this.info || {}),
                },
                interfaces: [ScryptedInterface.OnOff],
                type: ScryptedDeviceType.Light,
            });
        }

        if (hasPir) {
            const pirNativeId = `${this.nativeId}-pir`;
            devices.push({
                providerNativeId: this.plugin?.nativeId,
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

    // Settings methods
    async getSettings(): Promise<Setting[]> {
        return await this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: string): Promise<void> {
        await this.storageSettings.putSetting(key, value);
    }

    // Camera interface methods (must be implemented by subclasses)
    abstract takePicture(options?: any): Promise<MediaObject>;
    abstract getPictureOptions(): Promise<any[]>;

    // Intercom interface methods
    async startIntercom(media: MediaObject): Promise<void> {
        if (this.intercom) {
            await this.intercom.start(media);
        } else {
            throw new Error('Intercom not initialized');
        }
    }

    async stopIntercom(): Promise<void> {
        if (this.intercom) {
            return await this.intercom.stop();
        } else {
            throw new Error('Intercom not initialized');
        }
    }

    // Device info update
    async updateDeviceInfo(): Promise<void> {
        const ip = this.storageSettings.values.ipAddress;
        try {
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
        } catch (e) {
            // If API call fails, at least set basic info
            const info = this.info || {};
            info.ip = ip;
            info.manufacturer = 'Reolink native';
            info.managementUrl = `http://${ip}`;
            this.info = info;
            this.getLogger().warn('Failed to fetch device info', e);
        }
    }

    // Device provider methods
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

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        if (nativeId.endsWith('-siren')) {
            this.siren = undefined;
        } else if (nativeId.endsWith('-floodlight')) {
            this.floodlight = undefined;
        } else if (nativeId.endsWith('-pir')) {
            this.pirSensor = undefined;
        }
    }

    // Auxiliary device control methods
    async setSirenEnabled(enabled: boolean): Promise<void> {
        const channel = this.getRtspChannel();

        // Use withBaichuanClient if available (for battery cameras), otherwise use withBaichuanRetry or direct call
        if (this.withBaichuanClient) {
            await this.withBaichuanClient(async (api) => {
                await api.setSiren(channel, enabled);
            });
        } else {
            const retryFn = this.withBaichuanRetry || (async <T>(fn: () => Promise<T>): Promise<T> => {
                return await fn();
            });
            await retryFn(async () => {
                const api = await this.ensureClient();
                return await api.setSiren(channel, enabled);
            });
        }
    }

    async setFloodlightState(on?: boolean, brightness?: number): Promise<void> {
        const channel = this.getRtspChannel();

        // Use withBaichuanClient if available (for battery cameras), otherwise use withBaichuanRetry or direct call
        if (this.withBaichuanClient) {
            await this.withBaichuanClient(async (api) => {
                await api.setWhiteLedState(channel, on, brightness);
            });
        } else {
            const retryFn = this.withBaichuanRetry || (async <T>(fn: () => Promise<T>): Promise<T> => {
                return await fn();
            });
            await retryFn(async () => {
                const api = await this.ensureClient();
                return await api.setWhiteLedState(channel, on, brightness);
            });
        }
    }

    async setPirEnabled(enabled: boolean): Promise<void> {
        const channel = this.getRtspChannel();

        // Use withBaichuanClient if available (for battery cameras), otherwise use withBaichuanRetry or direct call
        if (this.withBaichuanClient) {
            await this.withBaichuanClient(async (api) => {
                await api.setPirInfo(channel, { enable: enabled ? 1 : 0 });
            });
        } else {
            const retryFn = this.withBaichuanRetry || (async <T>(fn: () => Promise<T>): Promise<T> => {
                return await fn();
            });
            await retryFn(async () => {
                const api = await this.ensureClient();
                return await api.setPirInfo(channel, { enable: enabled ? 1 : 0 });
            });
        }
    }

    // Video stream helper methods
    protected addRtspCredentials(rtspUrl: string): string {
        const { username, password } = this.storageSettings.values;
        if (!username) {
            return rtspUrl;
        }

        try {
            const url = new URL(rtspUrl);

            // For RTMP, add credentials as query parameters (matching reolink plugin behavior)
            // The reolink plugin uses query parameters from client.parameters (token or user/password)
            // Since we use Baichuan and don't have client.parameters, we use user/password
            if (url.protocol === 'rtmp:') {
                const params = url.searchParams;
                params.set('user', username);
                params.set('password', password || '');
            } else {
                // For RTSP, add credentials in URL auth
                url.username = username;
                url.password = password || '';
            }

            return url.toString();
        } catch (e) {
            // If URL parsing fails, return original URL
            this.getLogger().warn('Failed to parse URL for credentials', e);
            return rtspUrl;
        }
    }

    protected getRtspAddress(): string {
        const { ipAddress } = this.storageSettings.values;
        const rtspPort = this.cachedNetPort?.rtsp?.port ?? 554;
        return `${ipAddress}:${rtspPort}`;
    }

    protected getRtmpAddress(): string {
        const { ipAddress } = this.storageSettings.values;
        const rtmpPort = this.cachedNetPort?.rtmp?.port ?? 1935;
        return `${ipAddress}:${rtmpPort}`;
    }

    protected async ensureNetPortCache(): Promise<void> {
        if (this.cachedNetPort) {
            return;
        }

        // Implement backoff to avoid spam when socket is closed
        const now = Date.now();
        if (now - this.lastNetPortCacheAttempt < this.netPortCacheBackoffMs) {
            // Use defaults if we're in backoff period
            this.cachedNetPort = {
                rtsp: { port: 554, enable: 1 },
                rtmp: { port: 1935, enable: 1 },
            };
            return;
        }

        this.lastNetPortCacheAttempt = now;

        try {
            const client = await this.ensureClient();
            this.cachedNetPort = await client.getNetPort();
        } catch (e) {
            // Only log if it's not a recoverable error to avoid spam
            if (!this.isRecoverableBaichuanError?.(e)) {
                this.getLogger().warn('Failed to get net port, using defaults', e);
            }
            // Use defaults if we can't get the ports
            this.cachedNetPort = {
                rtsp: { port: 554, enable: 1 },
                rtmp: { port: 1935, enable: 1 },
            };
        }
    }

    async getVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        const logger = this.getLogger();

        if (this.cachedVideoStreamOptions?.length) {
            return this.cachedVideoStreamOptions;
        }

        if (this.fetchingStreams) {
            return [];
        }

        // while (this.fetchingStreams) {
        //     await new Promise((resolve) => setTimeout(resolve, 500));
        // }
        this.fetchingStreams = true;

        let streams: UrlMediaStreamOptions[] = [];

        const client = await this.ensureClient();

        const { ipAddress, username, password, rtspChannel } = this.storageSettings.values;

        try {
            await this.ensureNetPortCache();
        } catch (e) {
            if (!this.isRecoverableBaichuanError?.(e)) {
                logger.warn('Failed to ensure net port cache, falling back to Native', e);
            }
        }

        try {
            streams = await buildVideoStreamOptionsFromRtspRtmp(
                client,
                rtspChannel,
                ipAddress,
                username,
                password,
                this.cachedNetPort,
            );
        } catch (e) {
            if (!this.isRecoverableBaichuanError?.(e)) {
                logger.warn('Failed to build RTSP/RTMP stream options, falling back to Native', e);
            }
            this.cachedNetPort = undefined;
        }


        const nativeStreams = await fetchVideoStreamOptionsFromApi(client, rtspChannel, this.getLogger());
        streams = [...streams, ...nativeStreams];

        if (streams.length) {
            logger.log('Fetched video stream options', streams);
            this.cachedVideoStreamOptions = streams;
            return streams;
        }

        this.fetchingStreams = false;
    }

    async getVideoStream(vso: RequestMediaStreamOptions): Promise<MediaObject> {
        if (!vso) throw new Error("video streams not set up or no longer exists.");

        const vsos = await this.getVideoStreamOptions();
        const selected = selectStreamOption(vsos, vso);

        // Check if this is a native stream (prefixed with "native_")
        const isNative = isNativeStreamId(selected.id);

        // If stream has RTSP/RTMP URL (not native), add credentials and create MediaStreamUrl
        if (!isNative && selected.url && (selected.container === 'rtsp' || selected.container === 'rtmp')) {
            const urlWithCredentials = this.addRtspCredentials(selected.url);
            const ret: MediaStreamUrl = {
                container: selected.container,
                url: urlWithCredentials,
                mediaStreamOptions: selected,
            };
            return await this.createMediaObject(ret, ScryptedMimeTypes.MediaStreamUrl);
        }

        // Use streamManager for native Baichuan streams (native_* or streams without URL)
        if (!this.streamManager) {
            throw new Error('StreamManager not initialized');
        }

        const profile = parseStreamProfileFromId(selected.id) || 'main';
        const channel = this.getRtspChannel();
        const streamKey = `${channel}_${profile}`;
        const expectedVideoType = expectedVideoTypeFromUrlMediaStreamOptions(selected);

        const createStreamFn = async () => {
            return await createRfc4571MediaObjectFromStreamManager({
                streamManager: this.streamManager!,
                channel,
                profile,
                streamKey,
                expectedVideoType,
                selected,
                sourceId: this.id,
                onDetectedCodec: (detectedCodec) => {
                    // Update cached stream options with detected codec
                    const nativeId = `native_${profile}`;
                    const name = `Native ${profile}`;

                    const prev = this.cachedVideoStreamOptions ?? [];
                    const next = prev.filter((s) => s.id !== nativeId);
                    next.push({ 
                        name, 
                        id: nativeId, 
                        container: 'rtp', 
                        video: { codec: detectedCodec }, 
                        url: `` 
                    });
                    this.cachedVideoStreamOptions = next;
                },
            });
        };

        // Use withBaichuanRetry for regular cameras, direct call for battery cameras
        if (this.withBaichuanRetry) {
            return await this.withBaichuanRetry(createStreamFn);
        } else {
            return await createStreamFn();
        }
    }

    // Client management
    async ensureClient(): Promise<ReolinkBaichuanApi> {
        // Reuse existing client if socket is still connected and logged in
        if (this.baichuanApi && this.baichuanApi.client.isSocketConnected() && this.baichuanApi.client.loggedIn) {
            return this.baichuanApi;
        }

        // Prevent concurrent login storms
        if (this.ensureClientPromise) return await this.ensureClientPromise;

        this.ensureClientPromise = (async () => {
            const { ipAddress, username, password, uid } = this.storageSettings.values;

            if (!ipAddress || !username || !password) {
                throw new Error('Missing camera credentials');
            }

            // Only tear down previous session if it exists and is not connected
            if (this.baichuanApi) {
                const isConnected = this.baichuanApi.client.isSocketConnected();
                if (!isConnected) {
                    // Socket is closed, clean up
                    try {
                        if (this.onSimpleEvent) {
                            this.baichuanApi.offSimpleEvent(this.onSimpleEvent);
                        }
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
                } else {
                    // Socket is still connected, just re-attach event handler if needed
                    if (this.isEventDispatchEnabled?.() && this.onSimpleEvent) {
                        try {
                            this.baichuanApi.offSimpleEvent(this.onSimpleEvent);
                            this.baichuanApi.onSimpleEvent(this.onSimpleEvent);
                        }
                        catch {
                            // ignore
                        }
                    }
                    // Reuse existing client
                    this.connectionTime = Date.now();
                    return this.baichuanApi;
                }
            }

            // Create new client
            const debugOptions = this.getBaichuanDebugOptions?.();
            const normalizedUid = this.protocol === 'udp' ? normalizeUid(uid) : undefined;

            if (this.protocol === 'udp' && !normalizedUid) {
                throw new Error('UID is required for battery cameras (BCUDP)');
            }

            const api = await createBaichuanApi(
                {
                    host: ipAddress,
                    username,
                    password,
                    uid: normalizedUid,
                    logger: this.console,
                    ...(debugOptions ? { debugOptions } : {}),
                },
                this.protocol,
            );
            await api.login();

            // Verify socket is connected before returning
            if (!api.client.isSocketConnected()) {
                throw new Error('Socket not connected after login');
            }

            this.baichuanApi = api;
            this.connectionTime = Date.now();

            // Re-attach event handler if enabled
            if (this.isEventDispatchEnabled?.() && this.onSimpleEvent) {
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
            // Allow future reconnects and avoid pinning rejected promises
            this.ensureClientPromise = undefined;
        }
    }

    async credentialsChanged(): Promise<void> {
        this.cachedVideoStreamOptions = undefined;
        this.cachedNetPort = undefined;
    }

    // PTZ Presets methods
    getSelectedPresetId(): number | undefined {
        const s = this.storageSettings.values.ptzSelectedPreset;
        if (!s) return undefined;

        const idPart = s.includes('=') ? s.split('=')[0] : s;
        const id = Number(idPart);
        return Number.isFinite(id) ? id : undefined;
    }

    // Refresh device state (capabilities, presets, interfaces, aux devices)
    async refreshDeviceState(): Promise<void> {
        if (this.refreshingState) {
            return;
        }
        this.refreshingState = true;

        const logger = this.getLogger();
        const channel = this.getRtspChannel();

        try {
            const { capabilities, abilities, support, presets, objects } = await (this.withBaichuanRetry || (async (fn: () => Promise<any>) => fn()))(async () => {
                const api = await this.ensureClient();
                return await api.getDeviceCapabilities(channel);
            });
            this.classes = objects;
            this.presets = presets;
            this.storageSettings.values.capabilities = capabilities;
            this.ptzPresets.setCachedPtzPresets(presets);

            try {
                const { interfaces, type } = getDeviceInterfaces({
                    capabilities,
                    logger: this.console,
                });

                const device: Device = {
                    nativeId: this.nativeId,
                    providerNativeId: this.plugin?.nativeId,
                    name: this.name,
                    interfaces,
                    type,
                    info: this.info,
                };

                logger.log(`Updating device interfaces: ${JSON.stringify(device)}`);

                await sdk.deviceManager.onDeviceDiscovered(device);
            } catch (e) {
                logger.error('Failed to update device interfaces', e);
            }

            this.console.log(`Refreshed device capabilities: ${JSON.stringify({ capabilities, abilities, support, presets })}`);
        }
        catch (e) {
            logger.error('Failed to refresh abilities', e);
        }

        this.refreshingState = false;
    }

    async parentInit(): Promise<void> {
        const logger = this.getLogger();

        try {
            await this.ensureClient();
            await this.updateDeviceInfo();
        }
        catch (e) {
            logger.warn('Failed to update device info during init', e);
        }

        try {
            await this.refreshDeviceState();
        }
        catch (e) {
            logger.warn('Failed to connect/refresh during init', e);
        }

        try {
            await this.reportDevices();
        }
        catch (e) {
            logger.warn('Failed to report devices during init', e);
        }

        const { hasIntercom, hasPtz } = this.getAbilities();

        if (hasIntercom) {
            this.intercom = new ReolinkBaichuanIntercom(this);
        }

        if (hasPtz) {
            const choices = (this.presets || []).map((preset: any) => preset.id + '=' + preset.name);

            this.storageSettings.settings.presets.choices = choices;
            this.storageSettings.settings.ptzSelectedPreset.choices = choices;

            this.storageSettings.settings.presets.hide = false;
            this.storageSettings.settings.ptzMoveDurationMs.hide = false;
            this.storageSettings.settings.ptzZoomStep.hide = false;
            this.storageSettings.settings.ptzCreatePreset.hide = false;
            this.storageSettings.settings.ptzSelectedPreset.hide = false;
            this.storageSettings.settings.ptzUpdateSelectedPreset.hide = false;
            this.storageSettings.settings.ptzDeleteSelectedPreset.hide = false;

            this.updatePtzCaps();
        }

        const isBattery = this.options.type === 'battery';

        this.storageSettings.settings.snapshotCacheMinutes.hide = !isBattery;
        this.storageSettings.settings.uid.hide = !isBattery;

        if (isBattery && !this.storageSettings.values.mixinsSetup) {
            try {
                const device = sdk.systemManager.getDeviceById<Settings>(this.id);
                if (device) {
                    logger.log('Disabling prebuffer and snapshots from prebuffer');
                    await device.putSetting('prebuffer:enabledStreams', '[]');
                    await device.putSetting('snapshot:snapshotsFromPrebuffer', 'Disabled');
                    this.storageSettings.values.mixinsSetup = true;
                }
            }
            catch (e) {
                logger.warn('Failed to setup mixins during init', e);
            }
        }

        try {
            await this.subscribeToEvents();
        }
        catch (e) {
            logger.warn('Failed to subscribe to Baichuan events', e);
        }

        await this.init();
        this.initComplete = true;
    }
}


