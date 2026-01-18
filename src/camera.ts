import type { BaichuanClientOptions, BatteryInfo, DeviceCapabilities, NativeVideoStreamVariant, PtzCommand, PtzPreset, ReolinkBaichuanApi, ReolinkSimpleEvent, ReolinkSupportedStream, SleepStatus, StreamProfile, StreamSamplingSelection } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { BinarySensor, Brightness, Camera, Device, DeviceProvider, Intercom, MediaObject, MediaStreamUrl, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, OnOff, PanTiltZoom, PanTiltZoomCommand, Reboot, RequestMediaStreamOptions, RequestPictureOptions, ResponsePictureOptions, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions, VideoTextOverlay, VideoTextOverlays } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { spawn } from 'node:child_process';
import type { UrlMediaStreamOptions } from "../../scrypted/plugins/rtsp/src/rtsp";
import { BaseBaichuanClass, type BaichuanConnectionCallbacks, type BaichuanConnectionConfig } from "./baichuan-base";
import { createBaichuanApi, normalizeUid, type BaichuanTransport } from "./connect";
import { convertDebugLogsToApiOptions, getApiRelevantDebugLogs, getDebugLogChoices } from "./debug-options";
import { ReolinkBaichuanIntercom } from "./intercom";
import ReolinkNativePlugin from "./main";
import { ReolinkNativeMultiFocalDevice } from "./multiFocal";
import { ReolinkNativeNvrDevice } from "./nvr";
import { ReolinkPtzPresets } from "./presets";
import {
    createRfc4571MediaObjectFromStreamManager,
    selectStreamOption,
    StreamManager,
    StreamManagerOptions
} from "./stream-utils";
import { floodlightSuffix, getDeviceInterfaces, pirSuffix, recordingsToVideoClips, sanitizeFfmpegOutput, sirenSuffix, updateDeviceInfo } from "./utils";

export type CameraType = 'battery' | 'regular' | 'multi-focal' | 'multi-focal-battery';

export interface ReolinkCameraOptions {
    type: CameraType;
    nvrDevice?: ReolinkNativeNvrDevice; // Optional reference to NVR device
    multiFocalDevice?: ReolinkNativeMultiFocalDevice; // Optional reference to multi-focal device
}

class ReolinkCameraSiren extends ScryptedDeviceBase implements OnOff {
    constructor(public camera: ReolinkCamera, nativeId: string) {
        super(nativeId);
    }

    async turnOff(): Promise<void> {
        this.camera.getBaichuanLogger().log(`Siren toggle: turnOff (device=${this.nativeId})`);
        this.on = false;
        try {
            await this.camera.setSirenEnabled(false);
            this.camera.getBaichuanLogger().log(`Siren toggle: turnOff ok (device=${this.nativeId})`);
        }
        catch (e) {
            this.camera.getBaichuanLogger().error(`Siren toggle: turnOff failed (device=${this.nativeId})`, e?.message || String(e));
            throw e;
        }
    }

    async turnOn(): Promise<void> {
        this.camera.getBaichuanLogger().log(`Siren toggle: turnOn (device=${this.nativeId})`);
        this.on = true;
        try {
            await this.camera.setSirenEnabled(true);
            this.camera.getBaichuanLogger().log(`Siren toggle: turnOn ok (device=${this.nativeId})`);
        }
        catch (e) {
            this.camera.getBaichuanLogger().error(`Siren toggle: turnOn failed (device=${this.nativeId})`, e?.message || String(e));
            throw e;
        }
    }
}

class ReolinkCameraFloodlight extends ScryptedDeviceBase implements OnOff, Brightness {
    constructor(public camera: ReolinkCamera, nativeId: string) {
        super(nativeId);
    }

    async setBrightness(brightness: number): Promise<void> {
        this.camera.getBaichuanLogger().log(`Floodlight toggle: setBrightness (device=${this.nativeId} brightness=${brightness})`);
        this.brightness = brightness;
        try {
            await this.camera.setFloodlightState(undefined, brightness);
            this.camera.getBaichuanLogger().log(`Floodlight toggle: setBrightness ok (device=${this.nativeId} brightness=${brightness})`);
        }
        catch (e) {
            this.camera.getBaichuanLogger().warn(`Floodlight toggle: setBrightness failed (device=${this.nativeId} brightness=${brightness})`, e?.message || String(e));
            throw e;
        }
    }

    async turnOff(): Promise<void> {
        this.camera.getBaichuanLogger().log(`Floodlight toggle: turnOff (device=${this.nativeId})`);
        this.on = false;
        try {
            await this.camera.setFloodlightState(false);
            this.camera.getBaichuanLogger().log(`Floodlight toggle: turnOff ok (device=${this.nativeId})`);
        }
        catch (e) {
            this.camera.getBaichuanLogger().warn(`Floodlight toggle: turnOff failed (device=${this.nativeId})`, e?.message || String(e));
            throw e;
        }
    }

    async turnOn(): Promise<void> {
        this.camera.getBaichuanLogger().log(`Floodlight toggle: turnOn (device=${this.nativeId})`);
        this.on = true;
        try {
            await this.camera.setFloodlightState(true);
            this.camera.getBaichuanLogger().log(`Floodlight toggle: turnOn ok (device=${this.nativeId})`);
        }
        catch (e) {
            this.camera.getBaichuanLogger().warn(`Floodlight toggle: turnOn failed (device=${this.nativeId})`, e?.message || String(e));
            throw e;
        }
    }
}

class ReolinkCameraPirSensor extends ScryptedDeviceBase implements OnOff, Settings {
    storageSettings = new StorageSettings(this, {
        sensitive: {
            title: 'PIR Sensitivity',
            description: 'Detection sensitivity/threshold (higher = more sensitive)',
            type: 'number',
            defaultValue: 50,
            range: [0, 100],
        },
        reduceAlarm: {
            title: 'Reduce False Alarms',
            description: 'Enable reduction of false alarm rate',
            type: 'boolean',
            defaultValue: false,
        },
        interval: {
            title: 'PIR Detection Interval',
            description: 'Detection interval in seconds',
            type: 'number',
            defaultValue: 5,
            range: [1, 60],
        },
    });

    constructor(public camera: ReolinkCamera, nativeId: string) {
        super(nativeId);
    }

    async getSettings(): Promise<Setting[]> {
        const settings = await this.storageSettings.getSettings();
        return settings;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        await this.storageSettings.putSetting(key, value);

        // Apply the new settings to the camera
        const channel = this.camera.storageSettings.values.rtspChannel;
        const enabled = this.on ? 1 : 0;
        const sensitive = this.storageSettings.values.sensitive;
        const reduceAlarm = this.storageSettings.values.reduceAlarm ? 1 : 0;
        const interval = this.storageSettings.values.interval;

        await this.camera.withBaichuanRetry(async () => {
            const api = await this.camera.ensureClient();
            await api.setPirInfo(channel, {
                enable: enabled,
                sensitive: sensitive,
                reduceAlarm: reduceAlarm,
                interval: interval,
            });
        });
    }

    async turnOff(): Promise<void> {
        this.on = false;
        await this.updatePirSettings();
    }

    async turnOn(): Promise<void> {
        this.on = true;
        await this.updatePirSettings();
    }

    private async updatePirSettings(): Promise<void> {
        const channel = this.camera.storageSettings.values.rtspChannel;
        const enabled = this.on ? 1 : 0;
        const sensitive = this.storageSettings.values.sensitive;
        const reduceAlarm = this.storageSettings.values.reduceAlarm ? 1 : 0;
        const interval = this.storageSettings.values.interval;

        await this.camera.withBaichuanRetry(async () => {
            const api = await this.camera.ensureClient();
            await api.setPirInfo(channel, {
                enable: enabled,
                sensitive: sensitive,
                reduceAlarm: reduceAlarm,
                interval: interval,
            });
        });
    }
}

export class ReolinkCamera extends BaseBaichuanClass implements VideoCamera, Camera, Settings, DeviceProvider, ObjectDetector, PanTiltZoom, VideoTextOverlays, BinarySensor, Intercom, Reboot, VideoClips {
    private readonly onSimpleEventBound = (ev: ReolinkSimpleEvent) => this.onSimpleEvent(ev);

    storageSettings = new StorageSettings(this, {
        debugLogs: {
            title: 'Debug logs',
            type: 'boolean',
            immediate: true,
        },
        // Basic connection settings
        ipAddress: {
            title: 'IP Address',
            hide: true,
            type: 'string',
            onPut: async () => {
                await this.credentialsChanged();
            }
        },
        username: {
            type: 'string',
            hide: true,
            title: 'Username',
            onPut: async () => {
                await this.credentialsChanged();
            }
        },
        password: {
            type: 'password',
            hide: true,
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
        variantType: {
            type: 'string',
            hide: true,
            defaultValue: 'default',
            choices: ['default', 'autotrack', 'telephoto'] as NativeVideoStreamVariant[],
        },
        preferredStreams: {
            type: 'string',
            title: 'Preferred Stream Order',
            description: 'Order preference for video streams. Default: RTSP -> RTMP -> Native',
            defaultValue: 'Default',
            choices: ['Default', 'Native', 'RTSP', 'RTMP'],
            subgroup: 'Streaming',
        },
        // capabilities: {
        //     json: true,
        //     hide: true,
        // },
        multifocalInfo: {
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
        discoveryMethod: {
            title: 'Discovery Method',
            description: 'UDP discovery method for battery cameras (BCUDP).',
            type: 'string',
            choices: ['local-direct', 'local-broadcast', 'remote', 'map', 'relay'],
            defaultValue: 'local-direct',
            hide: true,
            subgroup: 'Advanced',
            onPut: async () => {
                await this.credentialsChanged();
            }
        },
        mixinsSetup: {
            type: 'boolean',
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
        socketApiDebugLogs: {
            subgroup: 'Advanced',
            title: 'Socket API Debug Logs',
            description: 'Enable specific debug logs.',
            multiple: true,
            combobox: true,
            immediate: true,
            defaultValue: [],
            choices: getDebugLogChoices(),
            onPut: async (ov, value) => {
                const logger = this.getBaichuanLogger();
                const oldApiOptions = getApiRelevantDebugLogs(ov || []);
                const newApiOptions = getApiRelevantDebugLogs(value || []);

                const oldSel = new Set(oldApiOptions);
                const newSel = new Set(newApiOptions);

                const changed = oldSel.size !== newSel.size || Array.from(oldSel).some((k) => !newSel.has(k));
                if (changed && this.resetBaichuanClient) {
                    // Clear any existing timeout
                    if (this.debugLogsResetTimeout) {
                        clearTimeout(this.debugLogsResetTimeout);
                        this.debugLogsResetTimeout = undefined;
                    }

                    // Defer reset by 2 seconds to allow settings to settle
                    this.debugLogsResetTimeout = setTimeout(async () => {
                        this.debugLogsResetTimeout = undefined;
                        try {
                            await this.resetBaichuanClient('debugLogs changed');
                            // Force reconnection with new debug options
                            this.baichuanApi = undefined;
                            this.ensureClientPromise = undefined;
                            // Trigger reconnection
                            await this.ensureClient();
                        } catch (e) {
                            logger.warn('Failed to reset client after debug logs change', e?.message || String(e));
                        }
                    }, 2000);
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
            subgroup: 'PTZ',
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
            subgroup: 'PTZ',
            hide: true,
        },
        ptzZoomStep: {
            subgroup: 'PTZ',
            title: 'PTZ Zoom Step',
            description: 'How much to change zoom per zoom command (in zoom factor units, where 1.0 is normal).',
            type: 'number',
            defaultValue: 0.1,
            hide: true,
        },
        ptzCreatePreset: {
            subgroup: 'PTZ',
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

                const logger = this.getBaichuanLogger();
                logger.log(`PTZ presets: create preset requested (name=${name})`);

                const preset = await this.withBaichuanRetry(async () => {
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
            subgroup: 'PTZ',
            title: 'Selected Preset',
            description: 'Select the preset to update or delete. Format: "id=name".',
            type: 'string',
            combobox: false,
            immediate: true,
            hide: true,
        },
        ptzUpdateSelectedPreset: {
            subgroup: 'PTZ',
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

                const logger = this.getBaichuanLogger();
                logger.log(`PTZ presets: update position requested (presetId=${presetId})`);

                await this.withBaichuanRetry(async () => {
                    await this.ensureClient();
                    return await (this.ptzPresets).updatePtzPresetToCurrentPosition(presetId);
                });
                logger.log(`PTZ presets: update position ok (presetId=${presetId})`);
            },
        },
        ptzDeleteSelectedPreset: {
            subgroup: 'PTZ',
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

                const logger = this.getBaichuanLogger();
                logger.log(`PTZ presets: delete requested (presetId=${presetId})`);

                await this.withBaichuanRetry(async () => {
                    await this.ensureClient();
                    return await (this.ptzPresets).deletePtzPreset(presetId);
                });

                this.storageSettings.values.ptzSelectedPreset = '';
                logger.log(`PTZ presets: delete ok (presetId=${presetId})`);
            },
        },
        batteryUpdateIntervalMinutes: {
            title: "Battery Update Interval (minutes)",
            subgroup: 'Advanced',
            description: "How often to wake up the camera and update battery status and snapshot (default: 60 minutes).",
            type: "number",
            defaultValue: 60,
            hide: true,
        },
        lowThresholdBatteryRecording: {
            title: "Low Threshold Battery Recording (%)",
            subgroup: 'Recording',
            description: "Battery level threshold below which recording is disabled (default: 15%).",
            type: "number",
            defaultValue: 15,
            hide: true,
        },
        highThresholdBatteryRecording: {
            title: "High Threshold Battery Recording (%)",
            subgroup: 'Recording',
            description: "Battery level threshold above which recording is enabled (default: 35%).",
            type: "number",
            defaultValue: 35,
            hide: true,
        },
        diagnosticsOutputPath: {
            title: "Diagnostics Output Path",
            subgroup: 'Diagnostics',
            description: "Directory where diagnostics files will be saved (default: plugin volume).",
            type: "string",
            hide: true,
            defaultValue: path.join(process.env.SCRYPTED_PLUGIN_VOLUME, 'diagnostics', this.name),
        },
        enableVideoclips: {
            title: "Enable Video Clips",
            description: "Enable video clips functionality. If disabled, getVideoClips will return empty and all other videoclip settings are ignored.",
            type: "boolean",
            defaultValue: false,
            immediate: true,
            hide: true,
            onPut: async () => {
                this.updateVideoClipsAutoLoad();
            },
        },
        clipsSource: {
            title: "Clips Source",
            subgroup: 'Videoclips',
            description: "Source for fetching video clips: NVR (fetch from NVR device) or Device (fetch directly from camera).",
            type: "string",
            choices: ["NVR", "Device"],
            immediate: true,
            hide: true,
        },
        loadVideoclips: {
            title: "Auto-load Video Clips",
            subgroup: 'Videoclips',
            description: "Automatically fetch today's video clips and download missing thumbnails at regular intervals.",
            type: "boolean",
            defaultValue: false,
            immediate: true,
            hide: true,
            onPut: async () => {
                this.updateVideoClipsAutoLoad();
            },
        },
        videoclipsRegularChecks: {
            title: "Video Clips Check Interval (minutes)",
            subgroup: 'Videoclips',
            description: "How often to check for new video clips and download thumbnails (default: 30 minutes).",
            type: "number",
            defaultValue: 30,
            hide: true,
            onPut: async () => {
                this.updateVideoClipsAutoLoad();
            },
        },
        downloadVideoclipsLocally: {
            title: "Download Video Clips Locally",
            subgroup: 'Videoclips',
            description: "Automatically download and cache video clips to local filesystem during auto-load.",
            type: "boolean",
            defaultValue: false,
            immediate: true,
            hide: true,
            onPut: async () => {
                this.updateVideoClipsAutoLoad();
            },
        },
        videoclipsDaysToPreload: {
            title: "Days to Preload",
            subgroup: 'Videoclips',
            description: "Number of days to preload video clips and thumbnails (default: 1, only today).",
            type: "number",
            defaultValue: 3,
            hide: true,
            onPut: async () => {
                this.updateVideoClipsAutoLoad();
            },
        },
        diagnosticsRun: {
            subgroup: 'Diagnostics',
            title: 'Run Diagnostics',
            description: 'Run all diagnostics and save results to the output path.',
            type: 'button',
            hide: true,
            immediate: true,
            onPut: async () => {
                await this.runDiagnostics();
            },
        },
        // Multifocal composite stream PIP settings
        pipPosition: {
            title: 'PIP Position',
            description: 'Position of the tele lens overlay on the wider lens view',
            type: 'string',
            defaultValue: 'bottom-right',
            group: 'Composite stream',
            choices: [
                'top-left',
                'top-right',
                'bottom-left',
                'bottom-right',
                'center',
                'top-center',
                'bottom-center',
                'left-center',
                'right-center',
            ],
            hide: true, // Only show for multifocal devices via getAdditionalSettings
        },
        pipSize: {
            title: 'PIP Size',
            description: 'Relative size of the PIP overlay (0.1 = 10%, 0.3 = 30%, etc.)',
            type: 'number',
            defaultValue: 0.25,
            group: 'Composite stream',
            hide: true,
            onPut: async () => {
                this.scheduleStreamManagerRestart('pipSize changed');
            },
        },
        pipMargin: {
            title: 'PIP Margin',
            description: 'Margin from edge as a fraction of the output size (e.g. 0.01 = 1%). Values > 1 are treated as pixels (legacy).',
            type: 'number',
            defaultValue: 0.01,
            group: 'Composite stream',
            hide: true,
            onPut: async () => {
                this.scheduleStreamManagerRestart('pipMargin changed');
            },
        },

        compositeAssumeH264: {
            title: 'Composite: Assume H.264 Inputs',
            description: 'Assume both wider+tele inputs are H.264 (skips codec detection). Recommended when using sub+sub on TrackMix. If inputs are actually H.265, the composite may fail to start.',
            type: 'boolean',
            defaultValue: true,
            group: 'Composite stream',
            hide: true,
            onPut: async () => {
                this.scheduleStreamManagerRestart('compositeAssumeH264 changed');
            },
        },
        compositeDisableTranscode: {
            title: 'Composite: Disable Codec Transcode (Best-effort)',
            description: 'Best-effort knob. Overlay requires re-encode in ffmpeg; this option only avoids HEVC->H264 codec assumptions when possible. Leave off unless you know what you are doing.',
            type: 'boolean',
            defaultValue: false,
            group: 'Composite stream',
            hide: true,
            onPut: async () => {
                this.scheduleStreamManagerRestart('compositeDisableTranscode changed');
            },
        },
    });

    ptzPresets = new ReolinkPtzPresets(this);
    refreshingState = false;
    classes: string[] = [];
    presets: PtzPreset[] = [];
    streamManager?: StreamManager;
    intercom?: ReolinkBaichuanIntercom;

    siren?: ReolinkCameraSiren;
    floodlight?: ReolinkCameraFloodlight;
    pirSensor?: ReolinkCameraPirSensor;

    private lastPicture: { mo: MediaObject; atMs: number } | undefined;
    private takePictureInFlight: Promise<MediaObject> | undefined;
    forceNewSnapshot: boolean = false;

    public cachedCapabilities: DeviceCapabilities | undefined;

    // Video stream properties
    protected cachedVideoStreamOptions?: UrlMediaStreamOptions[];
    protected fetchingStreamsPromise: Promise<UrlMediaStreamOptions[]> | undefined;
    protected lastNetPortCacheAttempt: number = 0;
    protected netPortCacheBackoffMs: number = 5000; // 5 seconds backoff on failure

    // Client management (inherited from BaseBaichuanClass)
    private debugLogsResetTimeout: NodeJS.Timeout | undefined;

    motionTimeout?: NodeJS.Timeout;
    doorbellBinaryTimeout?: NodeJS.Timeout;

    protected nvrDevice?: ReolinkNativeNvrDevice;
    protected multiFocalDevice?: ReolinkNativeMultiFocalDevice;
    thisDevice: Settings;
    isBattery: boolean;
    isMultiFocal: boolean;
    isOnNvr: boolean;
    protocol: BaichuanTransport;
    private streamManagerRestartTimeout: NodeJS.Timeout | undefined;
    private videoClipsAutoLoadInterval: NodeJS.Timeout | undefined;
    private videoClipsAutoLoadInProgress: boolean = false;

    private batteryUpdatePromise: Promise<void> | undefined;
    private sleepCheckTimer: NodeJS.Timeout | undefined;
    private batteryUpdateTimer: NodeJS.Timeout | undefined;
    private periodicStarted = false;
    private statusPollTimer: NodeJS.Timeout | undefined;

    constructor(
        nativeId: string,
        public plugin: ReolinkNativePlugin,
        public options: ReolinkCameraOptions
    ) {
        const isBattery = options.type === 'battery' || options.type === 'multi-focal-battery';
        const transport = isBattery || !!options.nvrDevice ? 'udp' : 'tcp';
        super(nativeId, transport);
        this.plugin.camerasMap.set(this.id, this);

        // Store NVR device reference if provided
        this.nvrDevice = options.nvrDevice;
        this.multiFocalDevice = options.multiFocalDevice;
        this.thisDevice = sdk.systemManager.getDeviceById<Settings>(this.id);

        this.isBattery = isBattery;
        this.isMultiFocal = options.type === 'multi-focal' || options.type === 'multi-focal-battery';
        this.isOnNvr = !!this.nvrDevice || !!this.multiFocalDevice?.nvrDevice;
        this.protocol = transport;

        setTimeout(async () => {
            if (this.motionDetected) {
                this.motionDetected = false;
            }

            await this.init();
        }, 2000);
    }

    protected async withBaichuanClient<T>(fn: (api: ReolinkBaichuanApi) => Promise<T>): Promise<T> {
        const client = await this.ensureClient();
        return fn(client);
    }

    async getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]> {
        // Check if videoclips are enabled
        if (!this.storageSettings.values.enableVideoclips) {
            return [];
        }

        if (this.multiFocalDevice) {
            return this.multiFocalDevice.getVideoClips(options);
        }

        const isSleeping = !this.nvrDevice && this.isBattery && this.sleeping;

        // Skip sleeping check during auto-load to allow auto-load to start for battery cameras
        if (!this.videoClipsAutoLoadInProgress && isSleeping) {
            const logger = this.getBaichuanLogger();
            logger.debug('getVideoClips: disabled for battery devices');
            return [];
        }

        const logger = this.getBaichuanLogger();

        // Determine time window
        const nowMs = Date.now();
        const defaultWindowMs = 60 * 60 * 1000; // last 60 minutes

        const startMs = options?.startTime ?? (nowMs - defaultWindowMs);
        let endMs = options?.endTime ?? nowMs;
        const count = options?.count;

        if (endMs > nowMs) {
            endMs = nowMs;
        }

        if (endMs <= startMs) {
            logger.warn('getVideoClips: invalid time window, endTime <= startTime', {
                startTime: startMs,
                endTime: endMs,
            });
            return [];
        }

        const start = new Date(startMs);
        const end = new Date(endMs);
        start.setHours(0, 0, 0, 0);

        try {
            const { clipsSource } = this.storageSettings.values;
            const useNvr = clipsSource === "NVR" && this.nvrDevice;

            const api = await this.ensureClient();

            if (useNvr) {
                const channel = this.storageSettings.values.rtspChannel ?? 0;

                logger.debug(`[NVR VOD] Listing recordings: channel=${channel}, start=${start.toISOString()}, end=${end.toISOString()}`);
                const recordings = await api.listNvrRecordings({
                    channel,
                    start,
                    end,
                    streamType: "main",
                    autoSearchByDay: true,
                    fetchStreamUrls: false,
                });

                // Convert VOD recordings to VideoClip array using the shared parser
                const clips = await recordingsToVideoClips(recordings, {
                    fallbackStart: start,
                    logger,
                    plugin: this,
                    deviceId: this.id,
                    useWebhook: true,
                    count,
                });

                logger.debug(`[NVR VOD] Converted ${clips.length} video clips (limit: ${count || 'none'})`);

                return clips;
            } else {
                const recordings = await api.listDeviceRecordings({
                    start,
                    end,
                    count,
                    channel: this.storageSettings.values.rtspChannel,
                    streamType: 'mainStream',
                    httpFallback: false,
                    fetchRtmpUrls: false
                });

                // Convert recordings to VideoClip array using the shared parser
                const clips = await recordingsToVideoClips(recordings, {
                    fallbackStart: start,
                    api,
                    logger,
                    plugin: this,
                    deviceId: this.id,
                    useWebhook: true,
                    count,
                });

                logger.debug(`Videoclips found: ${clips.length}`);

                return clips;
            }
        } catch (e: any) {
            const message = e instanceof Error ? e.message : String(e);

            if (message?.includes('UID is required to access recordings')) {
                logger.log('getVideoClips: recordings not available or UID not resolvable for this device', {
                    error: message,
                });
            } else {
                logger.warn('getVideoClips: failed to list recordings', {
                    error: message,
                });
            }
            return [];
        }
    }

    /**
     * Get the cache directory for video clips and thumbnails
     */
    private getVideoClipCacheDir(): string {
        const pluginVolume = process.env.SCRYPTED_PLUGIN_VOLUME || '';
        const cameraId = this.id;
        return path.join(pluginVolume, 'videoclips', cameraId);
    }

    /**
     * Get cache file path for a video clip
     */
    getVideoClipCachePath(videoId: string): string {
        // Create a safe filename from videoId using hash
        const hash = crypto.createHash('md5').update(videoId).digest('hex');
        // Keep original extension if present, otherwise use .mp4
        const ext = videoId.includes('.') ? path.extname(videoId) : '.mp4';
        const cacheDir = this.getVideoClipCacheDir();
        return path.join(cacheDir, `${hash}${ext}`);
    }

    async getVideoClip(videoId: string): Promise<MediaObject> {
        const logger = this.getBaichuanLogger();
        try {
            const cacheEnabled = this.storageSettings.values.downloadVideoclipsLocally;
            const MIN_VIDEO_CACHE_BYTES = 16 * 1024;

            // Always check cache first, even if caching is disabled (in case user enabled it before)
            const cachePath = this.getVideoClipCachePath(videoId);
            const cacheDir = this.getVideoClipCacheDir();

            // Check if cached file exists
            try {
                await fs.promises.access(cachePath, fs.constants.F_OK);
                const stats = await fs.promises.stat(cachePath);
                if (stats.size < MIN_VIDEO_CACHE_BYTES) {
                    logger.warn(`[VideoClip] Cached file too small, deleting and re-downloading: fileId=${videoId}, size=${stats.size} bytes`);
                    try {
                        await fs.promises.unlink(cachePath);
                    } catch (unlinkErr) {
                        logger.warn(`[VideoClip] Failed to delete small cached file: fileId=${videoId}`, unlinkErr?.message || String(unlinkErr));
                    }
                } else {
                    logger.debug(`[VideoClip] Using cached file: fileId=${videoId}, size=${stats.size} bytes`);
                    // Return cached file as MediaObject
                    const mo = await sdk.mediaManager.createMediaObjectFromUrl(`file://${cachePath}`);
                    return mo;
                }
            } catch (e) {
                // File doesn't exist or error accessing it
                logger.debug(`[VideoClip] Cache miss: fileId=${videoId}, error=${e instanceof Error ? e.message : String(e)}`);
                if (cacheEnabled) {
                    logger.debug(`[VideoClip] Will download and cache: fileId=${videoId}`);
                }
            }

            // If caching is enabled, ensure cache directory exists
            if (cacheEnabled) {
                await fs.promises.mkdir(cacheDir, { recursive: true });
            }

            // const { clipsSource } = this.storageSettings.values;
            // const useNvr = clipsSource === "NVR" && this.nvrDevice;

            // Both standalone and NVR now use a URL-based playback path.
            // In NVR mode, `videoId` is expected to be a full recording path (e.g. /mnt/sda/...).
            const playbackUrl = await this.getVideoClipRtmpUrl(videoId);

            // If caching is enabled, download and cache the video via ffmpeg
            if (cacheEnabled) {
                const cachePath = this.getVideoClipCachePath(videoId);

                // Download and convert RTMP to MP4 using ffmpeg
                const ffmpegPath = await sdk.mediaManager.getFFmpegPath();
                const ffmpegArgs = [
                    '-i', playbackUrl,
                    '-c', 'copy', // Copy codecs without re-encoding
                    '-f', 'mp4',
                    '-movflags', 'frag_keyframe+empty_moov', // Enable streaming
                    cachePath,
                ];

                logger.log(`Downloading video clip to cache: ${cachePath}`);

                await new Promise<void>((resolve, reject) => {
                    const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
                        stdio: ['ignore', 'pipe', 'pipe'],
                    });

                    let errorOutput = '';

                    ffmpeg.stderr.on('data', (chunk: Buffer) => {
                        errorOutput += chunk.toString();
                    });

                    ffmpeg.on('close', (code) => {
                        if (code !== 0) {
                            const sanitized = sanitizeFfmpegOutput(errorOutput);
                            logger.error(`ffmpeg failed to download video clip: ${sanitized}`);
                            reject(new Error(`ffmpeg failed with code ${code}: ${sanitized}`));
                            return;
                        }

                        logger.log(`Video clip cached successfully: ${cachePath}`);
                        resolve();
                    });

                    ffmpeg.on('error', (error) => {
                        logger.error(`ffmpeg spawn error for video clip ${videoId}`, error?.message || String(error));
                        reject(error);
                    });

                    // Timeout after 5 minutes
                    const timeout = setTimeout(() => {
                        ffmpeg.kill('SIGKILL');
                        reject(new Error('Video clip download timeout'));
                    }, 5 * 60 * 1000);

                    ffmpeg.on('close', () => {
                        clearTimeout(timeout);
                    });
                });

                // Return cached file as MediaObject
                const mo = await sdk.mediaManager.createMediaObjectFromUrl(`file://${cachePath}`);
                return mo;
            } else {
                // Caching disabled, return playback URL directly (RTMP for standalone camera)
                const mo = await sdk.mediaManager.createMediaObjectFromUrl(playbackUrl);
                return mo;
            }
        } catch (e) {
            logger.error(`getVideoClip: failed to get video clip ${videoId}`, e?.message || String(e));
            throw e;
        }
    }

    /**
     * Get the cache directory for thumbnails (same as video clips)
     */
    private getThumbnailCacheDir(): string {
        // Use the same directory as video clips
        return this.getVideoClipCacheDir();
    }

    /**
     * Get cache file path for a thumbnail
     */
    private getThumbnailCachePath(fileId: string): string {
        // Use the same hash and base name as video clips, but with .jpg extension
        const hash = crypto.createHash('md5').update(fileId).digest('hex');
        const cacheDir = this.getThumbnailCacheDir();
        return path.join(cacheDir, `${hash}.jpg`);
    }

    async getVideoClipThumbnail(thumbnailId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        if (this.multiFocalDevice) {
            return this.multiFocalDevice.getVideoClipThumbnail(thumbnailId, options);
        }

        const logger = this.getBaichuanLogger();

        try {
            // Check cache first
            const cachePath = this.getThumbnailCachePath(thumbnailId);
            const cacheDir = this.getThumbnailCacheDir();
            const MIN_THUMB_CACHE_BYTES = 512; // 0.5KB, evita file vuoti o quasi

            try {
                await fs.promises.access(cachePath, fs.constants.F_OK);
                const stats = await fs.promises.stat(cachePath);
                if (stats.size < MIN_THUMB_CACHE_BYTES) {
                    logger.warn(`[Thumbnail] Cached thumbnail too small, deleting and regenerating: fileId=${thumbnailId}, size=${stats.size} bytes`);
                    try {
                        await fs.promises.unlink(cachePath);
                    } catch (unlinkErr) {
                        logger.warn(`[Thumbnail] Failed to delete small cached thumbnail: fileId=${thumbnailId}`, unlinkErr?.message || String(unlinkErr));
                    }
                } else {
                    logger.debug(`[Thumbnail] Using cached: fileId=${thumbnailId}, size=${stats.size} bytes`);
                    // Return cached thumbnail as MediaObject
                    const mo = await sdk.mediaManager.createMediaObjectFromUrl(`file://${cachePath}`);
                    return mo;
                }
            } catch {
                // File doesn't exist, need to generate it
                logger.debug(`[Thumbnail] Cache miss: fileId=${thumbnailId}`);
            }

            // Ensure cache directory exists
            await fs.promises.mkdir(cacheDir, { recursive: true });

            // const { clipsSource } = this.storageSettings.values;
            // const useNvr = clipsSource === "NVR" && this.nvrDevice;

            // NVR mode: `thumbnailId` is expected to be a full recording path (e.g. /mnt/sda/...).
            // Use the same ffmpeg-based thumbnail extraction flow as other sources.

            // Check if video clip is already cached locally - use it instead of calling camera
            const videoCachePath = this.getVideoClipCachePath(thumbnailId);
            let useLocalVideo = false;
            try {
                await fs.promises.access(videoCachePath, fs.constants.F_OK);
                useLocalVideo = true;
                logger.debug(`[Thumbnail] Using local video file for thumbnail extraction: fileId=${thumbnailId}`);
            } catch {
                // Video not cached locally, will use RTMP URL
            }

            let thumbnail: MediaObject;

            if (useLocalVideo) {
                // Extract thumbnail from local video file
                thumbnail = await this.plugin.generateThumbnail({
                    deviceId: this.id,
                    fileId: thumbnailId,
                    filePath: videoCachePath,
                    device: this,
                });
            } else {
                // Get RTMP URL using the appropriate API (NVR or Baichuan)
                // Use forThumbnail=true to prefer Download over Playback (better for ffmpeg)
                const rtmpVodUrl = await this.getVideoClipRtmpUrl(thumbnailId, true);

                // Use the plugin's thumbnail generation queue with RTMP URL
                thumbnail = await this.plugin.generateThumbnail({
                    deviceId: this.id,
                    fileId: thumbnailId,
                    rtmpUrl: rtmpVodUrl,
                    device: this,
                });
            }

            // Cache the thumbnail
            try {
                const buffer = await sdk.mediaManager.convertMediaObjectToBuffer(thumbnail, 'image/jpeg');
                await fs.promises.writeFile(cachePath, buffer);
                logger.debug(`[Thumbnail] Cached: fileId=${thumbnailId}, size=${buffer.length} bytes`);
            } catch (e) {
                logger.warn(`[Thumbnail] Failed to cache: fileId=${thumbnailId}`, e?.message || String(e));
                // Continue even if caching fails
            }

            return thumbnail;
        } catch (e) {
            logger.error(`[Thumbnail] Error: fileId=${thumbnailId}`, e?.message || String(e));
            throw e;
        }
    }

    /**
     * Get RTMP URL for a video clip file
     * Handles both NVR source (full path) and Device source (filename only)
     * @param fileId - The file ID or full path
     * @param forThumbnail - If true, prefer Download over Playback (better for ffmpeg thumbnail extraction)
     */
    async getVideoClipRtmpUrl(fileId: string, forThumbnail: boolean = false): Promise<string> {
        const logger = this.getBaichuanLogger();
        const { clipsSource } = this.storageSettings.values;
        const useNvr = clipsSource === "NVR" && this.nvrDevice;

        if (useNvr) {
            // NVR mode: `fileId` is expected to be a full recording path (e.g. /mnt/sda/...).
            logger.debug(`[getVideoClipRtmpUrl] Using NVR VOD API for fileId="${fileId}"`);
            const api = await this.ensureClient();

            const channel = this.storageSettings.values.rtspChannel ?? 0;
            try {
                const url = await api.getVodUrl(fileId, channel, {
                    requestType: "Download",
                    streamType: "main",
                });
                if (url) return url;
            } catch (e: any) {
                logger.error(`[getVideoClipRtmpUrl] getVodUrl Download failed: ${e?.message || String(e)}`);
            }

            throw new Error(`No streaming URL found from NVR for file ${fileId} after trying Playback and Download methods`);
        } else {
            // Camera standalone: DEVE usare RTMP da Baichuan API
            logger.debug(`[getVideoClipRtmpUrl] Getting RTMP URL from Baichuan API for fileId="${fileId}" (camera standalone)`);
            const api = await this.ensureClient();
            const result = await api.getRecordingPlaybackUrls({
                fileName: fileId,
            });
            logger.debug(`[getVideoClipRtmpUrl] Baichuan RTMP URL received: rtmpVodUrl="${result.rtmpVodUrl || 'none'}"`);
            if (!result.rtmpVodUrl) {
                throw new Error(`No RTMP URL found from Baichuan API for file ${fileId}`);
            }
            return result.rtmpVodUrl;
        }
    }

    removeVideoClips(...videoClipIds: string[]): Promise<void> {
        throw new Error("removeVideoClips is not implemented yet.");
    }

    /**
     * Update video clips auto-load timer based on settings
     */
    private updateVideoClipsAutoLoad(): void {
        // Clear existing interval if any
        if (this.videoClipsAutoLoadInterval) {
            clearInterval(this.videoClipsAutoLoadInterval);
            this.videoClipsAutoLoadInterval = undefined;
        }

        // Check if videoclips are enabled at all
        const { enableVideoclips, loadVideoclips, videoclipsRegularChecks } = this.storageSettings.values;
        if (!enableVideoclips) {
            return;
        }


        if (!loadVideoclips) {
            return;
        }

        const logger = this.getBaichuanLogger();
        const intervalMs = videoclipsRegularChecks * 60 * 1000;

        logger.log(`Starting video clips auto-load: checking every ${videoclipsRegularChecks} minutes`);

        // Run immediately on start
        this.loadTodayVideoClipsAndThumbnails();

        // Then run at regular intervals
        this.videoClipsAutoLoadInterval = setInterval(() => {
            this.loadTodayVideoClipsAndThumbnails();
        }, intervalMs);
    }

    /**
     * Load today's video clips and download missing thumbnails
     */
    private async loadTodayVideoClipsAndThumbnails(): Promise<void> {
        // Prevent concurrent executions
        if (this.videoClipsAutoLoadInProgress) {
            const logger = this.getBaichuanLogger();
            logger.debug('Video clips auto-load already in progress, skipping...');
            return;
        }

        const logger = this.getBaichuanLogger();

        this.videoClipsAutoLoadInProgress = true;

        try {
            const daysToPreload = this.storageSettings.values.videoclipsDaysToPreload ?? 1;
            logger.log(`Auto-loading video clips and thumbnails for the last ${daysToPreload} day(s)...`);

            // Get date range (start of N days ago to now)
            const now = new Date();
            const startDate = new Date(now);
            startDate.setUTCDate(startDate.getUTCDate() - (daysToPreload - 1));
            startDate.setUTCHours(0, 0, 0, 0);
            startDate.setUTCMinutes(0, 0, 0);

            // Fetch video clips for the specified number of days
            const clips = await this.getVideoClips({
                startTime: startDate.getTime(),
                endTime: now.getTime(),
            });

            logger.log(`Found ${clips.length} video clips for the last ${daysToPreload} day(s)`);

            const downloadVideoclipsLocally = this.storageSettings.values.downloadVideoclipsLocally ?? false;

            // Track processed clips to avoid duplicate calls to the camera
            const processedClips = new Set<string>();

            // Download videos first (if enabled), then thumbnails for each clip
            for (const clip of clips) {
                // Skip if already processed (avoid duplicate calls)
                if (processedClips.has(clip.id)) {
                    logger.debug(`Skipping already processed clip: ${clip.id}`);
                    continue;
                }
                processedClips.add(clip.id);

                try {
                    // If downloadVideoclipsLocally is enabled, download the video clip first
                    // This allows the thumbnail to use the local file instead of calling the camera
                    if (downloadVideoclipsLocally) {
                        try {
                            // Call getVideoClip to trigger download and caching
                            await this.getVideoClip(clip.id);
                            logger.debug(`Downloaded video clip: ${clip.id}`);
                        } catch (e) {
                            logger.warn(`Failed to download video clip ${clip.id}:`, e instanceof Error ? e.message : String(e));
                        }
                    }

                    // Then get the thumbnail - this will use the local video file if available
                    // or call the camera if the video wasn't downloaded
                    try {
                        await this.getVideoClipThumbnail(clip.id);
                        logger.debug(`Downloaded thumbnail for clip: ${clip.id}`);
                    } catch (e) {
                        logger.warn(`Failed to load thumbnail for clip ${clip.id}:`, e instanceof Error ? e.message : String(e));
                    }
                } catch (e) {
                    logger.warn(`Error processing clip ${clip.id}:`, e instanceof Error ? e.message : String(e));
                }
            }

            logger.log(`Completed auto-loading video clips and thumbnails`);
        } catch (e) {
            logger.error('Error during auto-loading video clips:', e?.message || String(e));
        } finally {
            this.videoClipsAutoLoadInProgress = false;
        }
    }

    async reboot(): Promise<void> {
        const api = await this.ensureClient();
        await api.reboot();
    }

    // BaseBaichuanClass abstract methods implementation
    protected getConnectionConfig(): BaichuanConnectionConfig {
        const { ipAddress, username, password, uid, discoveryMethod } = this.storageSettings.values;
        const debugOptions = this.getBaichuanDebugOptions();
        const normalizedUid = this.isBattery ? normalizeUid(uid) : undefined;

        if (this.isBattery && !normalizedUid) {
            throw new Error('UID is required for battery cameras (BCUDP)');
        }

        // Prevent accidental connections to localhost (Node will default host=127.0.0.1 when host is undefined).
        // This shows up as connect ECONNREFUSED 127.0.0.1:9000 and will never recover with socket resets.
        if (!this.isBattery && !ipAddress) {
            throw new Error('IP Address is required for TCP devices');
        }

        return {
            host: ipAddress,
            username,
            password,
            uid: normalizedUid,
            transport: this.protocol,
            debugOptions,
            udpDiscoveryMethod: discoveryMethod as BaichuanClientOptions["udpDiscoveryMethod"],
        };
    }

    protected getStreamClientInputs(): BaichuanConnectionConfig {
        const { ipAddress, username, password, uid, discoveryMethod } = this.storageSettings.values;
        const debugOptions = this.getBaichuanDebugOptions();

        const normalizedUid = this.isBattery ? normalizeUid(uid) : undefined;
        if (this.isBattery && !normalizedUid) {
            throw new Error('UID is required for battery cameras (BCUDP)');
        }

        return {
            host: ipAddress,
            username,
            password,
            uid: normalizedUid,
            transport: this.transport,
            debugOptions,
            udpDiscoveryMethod: discoveryMethod as BaichuanClientOptions["udpDiscoveryMethod"],
        };
    }

    protected getConnectionCallbacks(): BaichuanConnectionCallbacks {
        return {
            onClose: async () => {
                // Reset client state on close
                // The base class already handles cleanup
                // For battery cameras, don't auto-resubscribe after idle disconnects
                // (idle disconnects are normal for battery cameras to save power)
                if (!this.isBattery) {
                    setTimeout(async () => {
                        try {
                            await this.subscribeToEvents();
                        } catch (e) {
                            const logger = this.getBaichuanLogger();
                            logger.warn('Failed to resubscribe to events after reconnection', e?.message || String(e));
                        }
                    }, 1000);
                }
            },
            onSimpleEvent: this.onSimpleEventBound,
            getEventSubscriptionEnabled: () => this.isEventDispatchEnabled?.() ?? false,
        };
    }

    protected isDebugEnabled(): boolean {
        return this.storageSettings.values.debugLogs;
    }

    protected getDeviceName(): string {
        return this.name || 'Camera';
    }

    async withBaichuanRetry<T>(fn: () => Promise<T>): Promise<T> {
        if (this.isBattery) {
            return await fn();
        } else {
            try {
                return await fn();
            } catch (e) {
                if (!this.isRecoverableBaichuanError(e)) {
                    throw e;
                }

                // Reset client and clear cache on recoverable error
                await this.resetBaichuanClient(e);

                // Important: callers must re-acquire the client inside fn.
                try {
                    return await fn();
                } catch (retryError) {
                    throw retryError;
                }
            }
        }
    }

    async runDiagnostics(): Promise<void> {
        const logger = this.getBaichuanLogger();
        const outputPath = this.storageSettings.values.diagnosticsOutputPath || process.env.SCRYPTED_PLUGIN_VOLUME || "";

        if (!outputPath) {
            throw new Error('Diagnostics output path is required');
        }

        const channel = this.storageSettings.values.rtspChannel || 0;
        const durationSeconds = 15;
        const selection: StreamSamplingSelection = {
            kinds: ['native'],
            profiles: ['main', 'ext', 'sub'],
        };

        logger.log(`Starting diagnostics with parameters: outDir=${outputPath}, channel=${channel}, durationSeconds=${durationSeconds}, selection=${JSON.stringify(selection)}`);

        try {
            const api = await this.ensureClient();
            const { ipAddress, username, password } = this.storageSettings.values;

            const result = await api.runAllDiagnosticsConsecutively({
                host: ipAddress,
                username,
                password,
                outDir: outputPath,
                channel,
                durationSeconds,
                selection,
                api,
            });

            logger.log(`Diagnostics completed successfully. Output directory: ${result.runDir}`);
            logger.log(`Diagnostics file: ${result.diagnosticsPath}`);
            logger.log(`Streams directory: ${result.streamsDir}`);
        } catch (e) {
            logger.error('Failed to run diagnostics', e?.message || String(e));
            throw e;
        }
    }

    protected async onBeforeCleanup(): Promise<void> {
        // Unsubscribe from events if needed
        if (this.baichuanApi) {
            try {
                this.baichuanApi.offSimpleEvent(this.onSimpleEventBound);
            }
            catch {
                // ignore
            }
        }
    }

    /**
     * Create a dedicated Baichuan API session for streaming (used by StreamManager).
     *
     * - For TCP devices (regular + multifocal), this creates a new TCP session with its own client.
     * - For UDP/battery devices, this reuses the existing client via ensureClient().
     */
    async createStreamClient(streamKey: string): Promise<ReolinkBaichuanApi> {
        // Determine who should create the socket based on device hierarchy:
        // 1. Camera of multifocal with nvrDevice -> nvrDevice creates the socket
        // 2. Camera of multifocal (without nvrDevice) -> multiFocalDevice creates the socket
        // 3. Camera of nvr -> nvrDevice creates the socket
        // 4. Standalone camera -> camera creates its own socket (via base class)

        // Case 1: Camera of multifocal with nvrDevice -> delegate to nvrDevice
        if (this.multiFocalDevice?.nvrDevice) {
            return await this.multiFocalDevice.nvrDevice.createStreamClient(streamKey);
        }

        // Case 2: Camera of multifocal (without nvrDevice) -> delegate to multiFocalDevice
        if (this.multiFocalDevice) {
            return await this.multiFocalDevice.createStreamClient(streamKey);
        }

        // Case 3: Camera of nvr -> delegate to nvrDevice
        if (this.nvrDevice) {
            return await this.nvrDevice.createStreamClient(streamKey);
        }

        // Case 4: Standalone camera -> create its own socket using base class method
        // For battery (BCUDP) cameras, streaming must be keyed by streamKey.
        // Do NOT reuse ensureClient(): composite needs two concurrent streams, and single-lens streams
        // should reuse the same API that composite already created for that same streamKey.
        if (this.isBattery) {
            return await super.createStreamClient(streamKey);
        }

        // For TCP standalone cameras, use base class createStreamClient which manages stream clients per streamKey
        return await super.createStreamClient(streamKey);
    }

    public async getAbilities(): Promise<DeviceCapabilities> {
        const logger = this.getBaichuanLogger();

        try {
            if (this.multiFocalDevice) {
                const variantType = this.storageSettings.values.variantType;
                const ifaces = await this.multiFocalDevice.getInterfaces(variantType);
                if (ifaces?.capabilities) return ifaces.capabilities;
            } else {
                if (this.cachedCapabilities) return this.cachedCapabilities;

                const client = await this.ensureClient();
                const { capabilities } = await client.getDeviceCapabilities(this.storageSettings.values.rtspChannel ?? 0);
                this.cachedCapabilities = capabilities;
                return capabilities;
            }
        } catch (e) {
            logger.error('Failed to get abilities', e);
            return {
                channel: this.storageSettings.values.rtspChannel ?? 0,
                ptzMode: 'none',
                hasPan: false,
                hasTilt: false,
                hasZoom: false,
                hasPresets: false,
                hasPtz: false,
                hasBattery: !!this.isBattery,
                hasIntercom: false,
                hasSiren: false,
                hasFloodlight: false,
                hasPir: false,
                isDoorbell: false,
            };
        }
    }

    getBaichuanDebugOptions(): any | undefined {
        const socketDebugLogs = this.storageSettings.values.socketApiDebugLogs || [];
        return convertDebugLogsToApiOptions(socketDebugLogs);
    }

    /**
     * Initialize or recreate the StreamManager, taking into account multifocal composite options.
     */
    protected initStreamManager(logger?: Console, forceRecreate: boolean = false): void {
        const { username, password } = this.storageSettings.values;
        // Ensure logger is always valid - use provided logger or get from device, fallback to console
        const validLogger = logger || this.getBaichuanLogger() || console;

        const baseOptions: StreamManagerOptions = {
            createStreamClient: this.createStreamClient.bind(this),
            logger: validLogger,
            credentials: {
                username,
                password,
            },
            sharedConnection: this.isBattery || !!this.nvrDevice,
        };

        if (this.isMultiFocal) {
            const { pipPosition, pipSize, pipMargin, rtspChannel, compositeAssumeH264, compositeDisableTranscode } = this.storageSettings.values;

            // On NVR/Hub, TrackMix lenses are selected via stream variant, not via a separate channel.
            // Use rtspChannel for BOTH wide and tele so the library can request tele via streamType/variant.
            const wider = this.isOnNvr ? rtspChannel : undefined;
            const tele = this.isOnNvr ? rtspChannel : undefined;

            // On standalone TrackMix/Duo, lens channels are often separate, but they are not always 0/1.
            // Prefer using the discovered multifocalInfo mapping when available.
            let derivedWider: number | undefined = wider;
            let derivedTele: number | undefined = tele;
            if (!this.isOnNvr) {
                try {
                    const info: any = this.storageSettings.values.multifocalInfo;
                    const channels: any[] = Array.isArray(info?.channels) ? info.channels : [];

                    const wideCh = channels.find((c) => c?.lensType === 'wide')?.channel
                        ?? channels.find((c) => c?.variantType === 'default')?.channel;
                    const teleCh = channels.find((c) => c?.lensType === 'telephoto')?.channel
                        ?? channels.find((c) => c?.variantType === 'telephoto')?.channel;

                    if (Number.isFinite(wideCh)) derivedWider = wideCh;
                    if (Number.isFinite(teleCh)) derivedTele = teleCh;

                    // Avoid setting nonsense; leave undefined to fall back to library defaults.
                    if (derivedWider === derivedTele) {
                        // Keep undefined behavior (defaults inside the library) unless we are on NVR.
                        derivedWider = undefined;
                        derivedTele = undefined;
                    }
                } catch {
                    // ignore and fall back to defaults
                }
            }

            baseOptions.compositeOptions = {
                widerChannel: derivedWider,
                teleChannel: derivedTele,
                pipPosition,
                pipSize,
                pipMargin,
                onNvr: this.isOnNvr,
                // Prefer H.264 for composite (sub+sub by default) to reduce GOP latency.
                forceH264: true,
                assumeH264Inputs: compositeAssumeH264 ?? true,
                disableTranscode: compositeDisableTranscode ?? false,
            };
        }

        if (!this.streamManager || forceRecreate) {
            this.streamManager = new StreamManager(baseOptions);
        }
    }

    /**
     * Debounced restart of StreamManager when PIP/composite settings change.
     * Also notifies listeners so that active streams (prebuffer, etc.) restart cleanly.
     */
    protected scheduleStreamManagerRestart(reason: string): void {
        const logger = this.getBaichuanLogger();
        logger.log(`Scheduling StreamManager restart (${reason})`);

        if (this.streamManagerRestartTimeout) {
            clearTimeout(this.streamManagerRestartTimeout);
            this.streamManagerRestartTimeout = undefined;
        }

        this.streamManagerRestartTimeout = setTimeout(async () => {
            this.streamManagerRestartTimeout = undefined;
            const logger = this.getBaichuanLogger();
            try {
                logger.log('Restarting StreamManager due to PIP/composite settings change');
                this.initStreamManager(logger, true);

                // Invalidate snapshot cache for battery/multifocal-battery so that
                // the next snapshot reflects the new PIP/composite configuration.
                if (this.isBattery) {
                    this.forceNewSnapshot = true;
                    this.lastPicture = undefined;
                }

                this.onDeviceEvent(ScryptedInterface.VideoCamera, undefined);
            } catch (e) {
                logger.error('Failed to restart StreamManager after settings change', e?.message || String(e));
            }
        }, 500);
    }

    isRecoverableBaichuanError(e: any): boolean {
        const message = e?.message || e?.toString?.() || '';
        return typeof message === 'string' && (
            message.includes('Baichuan socket closed') ||
            message.includes('Baichuan UDP stream closed') ||
            message.includes('Baichuan TCP socket is not connected') ||
            message.includes('socket hang up') ||
            message.includes('ECONNRESET') ||
            message.includes('EPIPE')
        );
    }

    async updatePtzCaps() {
        const { hasPan, hasTilt, hasZoom } = await this.getAbilities();
        this.ptzCapabilities = {
            ...this.ptzCapabilities,
            pan: hasPan,
            tilt: hasTilt,
            zoom: hasZoom,
        }
    }

    // Event subscription methods
    unsubscribedToEvents(): void {
        this.unsubscribeFromEvents().catch(() => {
        });

        if (this.motionDetected) {
            this.motionDetected = false;
        }
    }

    onSimpleEvent(ev: ReolinkSimpleEvent) {
        const logger = this.getBaichuanLogger();

        try {
            const logger = this.getBaichuanLogger();
            const isDispatchEnabled = this.isEventDispatchEnabled();

            logger.debug(`Baichuan event on camera (dispatch enabled: ${isDispatchEnabled}): ${JSON.stringify(ev)}`);

            if (!isDispatchEnabled) {
                logger.debug('Event dispatch is disabled, ignoring event');
                return;
            }

            const objects: string[] = [];
            let motion = false;

            switch (ev?.type) {
                case 'awake':
                case 'sleeping':
                    this.updateSleepingState({
                        reason: ev?.type === 'sleeping' ? 'sleeping' : 'awake',
                        state: ev.type === 'sleeping' ? 'sleeping' : 'awake',
                    }).catch((e) => {
                        logger.warn('Error updating sleeping state', e?.message || String(e));
                    });
                    return;

                case 'offline':
                case 'online':
                    this.updateOnlineState(ev.type === 'online').catch((e) => {
                        logger.warn('Error updating online state', e?.message || String(e));
                    });
                    return;

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
                    logger.error(`Unknown event type: ${ev?.type}`);
                    return;
            }

            this.processEvents({ motion, objects }).catch((e) => {
                logger.warn('Error processing events', e?.message || String(e));
            });
        }
        catch (e) {
            logger.warn('Error in onSimpleEvent handler', e?.message || String(e));
        }
    }

    /**
     * Subscribe to Baichuan events only if this is a standalone device (not a child of NVR or MultiFocal).
     * If this device has a parent (nvrDevice or multiFocalDevice), events will be forwarded from the parent.
     * This ensures that only the root device in the hierarchy subscribes to events, avoiding duplicate subscriptions.
     */
    async subscribeToEvents(): Promise<void> {
        // If this device has a parent (NVR or MultiFocal), don't subscribe - events will be forwarded from parent
        if (this.nvrDevice || this.multiFocalDevice) {
            const logger = this.getBaichuanLogger();
            logger.debug(`Device has parent (nvrDevice=${!!this.nvrDevice}, multiFocalDevice=${!!this.multiFocalDevice}), skipping event subscription (events will be forwarded from parent)`);
            return;
        }

        const logger = this.getBaichuanLogger();
        const selection = Array.from(this.getDispatchEventsSelection?.() ?? new Set()).sort();
        const enabled = selection.length > 0;

        logger.debug(`subscribeToEvents called: enabled=${enabled}, selection=[${selection.join(', ')}], protocol=${this.protocol}`);

        this.unsubscribedToEvents();

        const shouldDispatchMotion = selection.includes('motion');
        if (!shouldDispatchMotion) {
            if (this.motionTimeout) clearTimeout(this.motionTimeout);
            this.motionDetected = false;
        }

        if (!enabled) {
            logger.log('Event subscription disabled, unsubscribing');
            if (this.doorbellBinaryTimeout) {
                clearTimeout(this.doorbellBinaryTimeout);
                this.doorbellBinaryTimeout = undefined;
            }
            this.binaryState = false;
            return;
        }

        // IMPORTANT: use base subscription logic so the callback is properly bound.
        // Passing `this.onSimpleEvent` directly would lose `this` and can result in silent failures.
        try {
            await super.subscribeToEvents();
            logger.log(`Subscribed to events (${selection.join(', ')}) on ${this.protocol} connection`);
        }
        catch (e) {
            logger.warn('Failed to subscribe to Baichuan events', e?.message || String(e));
            return;
        }
    }

    // VideoTextOverlays interface implementation
    async getVideoTextOverlays(): Promise<Record<string, VideoTextOverlay>> {
        const client = await this.ensureClient();
        const channel = this.storageSettings.values.rtspChannel;

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
        const channel = this.storageSettings.values.rtspChannel;

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
        const logger = this.getBaichuanLogger();

        const client = await this.ensureClient();
        if (!client) {
            return;
        }

        const channel = this.storageSettings.values.rtspChannel;

        // Preset navigation.
        const preset = command.preset;
        if (preset !== undefined && preset !== null) {
            const presetId = Number(preset);
            if (!Number.isFinite(presetId)) {
                logger.warn(`Invalid PTZ preset id: ${preset}`);
                return;
            }
            if (this.ptzPresets) {
                await this.ptzPresets.moveToPreset(presetId);
            } else {
                logger.warn('PTZ presets not available');
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
                logger.warn('Invalid PTZ zoom step, using default 0.1');
                return;
            }

            // Get current zoom factor and apply step
            const info = await client.getZoomFocus(channel);
            if (!info?.zoom) {
                logger.warn('Zoom command requested but camera did not report zoom support.');
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

        const logger = this.getBaichuanLogger();

        const dispatchEvents = this.getDispatchEventsSelection?.() ?? new Set(['motion', 'objects']);
        const shouldDispatchMotion = dispatchEvents.has('motion');
        const shouldDispatchObjects = dispatchEvents.has('objects');

        logger.debug(`Processing events ${JSON.stringify({
            isMotion: events.motion,
            objects: events.objects,
            currentMotion: this.motionDetected,
            shouldDispatchMotion,
            shouldDispatchObjects,
        })}`);

        if (shouldDispatchMotion && events.motion !== undefined) {
            const motionDetected = events.motion;
            if (motionDetected !== this.motionDetected) {
                logger.log(`Motion detected: ${motionDetected}`);
                this.motionDetected = motionDetected;
            }

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

    async reportDevices(): Promise<void> {
        const abilities = await this.getAbilities();
        const logger = this.getBaichuanLogger();
        logger.debug(`Reporting devices: ${JSON.stringify(abilities)}`);

        const { hasSiren, hasFloodlight, hasPir } = abilities;

        if (hasSiren) {
            const sirenNativeId = `${this.nativeId}${sirenSuffix}`;
            const device: Device = {
                providerNativeId: this.nativeId,
                name: `${this.name} Siren`,
                nativeId: sirenNativeId,
                info: {
                    ...(this.info || {}),
                },
                interfaces: [ScryptedInterface.OnOff, ScryptedInterface.Settings],
                type: ScryptedDeviceType.Siren,
            };
            sdk.deviceManager.onDeviceDiscovered(device);
        }

        if (hasFloodlight) {
            const floodlightNativeId = `${this.nativeId}${floodlightSuffix}`;
            const device: Device = {
                providerNativeId: this.nativeId,
                name: `${this.name} Floodlight`,
                nativeId: floodlightNativeId,
                info: {
                    ...(this.info || {}),
                },
                interfaces: [ScryptedInterface.OnOff, ScryptedInterface.Settings],
                type: ScryptedDeviceType.Light,
            };
            sdk.deviceManager.onDeviceDiscovered(device);
        }

        if (hasPir) {
            const pirNativeId = `${this.nativeId}${pirSuffix}`;
            const device: Device = {
                providerNativeId: this.nativeId,
                name: `${this.name} PIR`,
                nativeId: pirNativeId,
                info: {
                    ...(this.info || {}),
                },
                interfaces: [ScryptedInterface.OnOff, ScryptedInterface.Settings],
                type: ScryptedDeviceType.Switch,
            };
            sdk.deviceManager.onDeviceDiscovered(device);
        }
    }

    async getSettings(): Promise<Setting[]> {
        const settings = await this.storageSettings.getSettings();

        return settings;
    }

    async putSetting(key: string, value: string): Promise<void> {
        await this.storageSettings.putSetting(key, value);
    }

    async takePictureInternal(client: ReolinkBaichuanApi) {
        const { rtspChannel, variantType } = this.storageSettings.values;
        const logger = this.getBaichuanLogger();
        logger.log(`Taking new snapshot from camera: forceNewSnapshot=${this.forceNewSnapshot} channel=${rtspChannel} variant=${variantType}`);

        const compositeOptions = this.isMultiFocal ? {
            widerChannel: this.isOnNvr ? rtspChannel : undefined,
            teleChannel: this.isOnNvr ? rtspChannel : undefined,
            pipPosition: this.storageSettings.values.pipPosition || 'bottom-right',
            pipSize: this.storageSettings.values.pipSize ?? 0.25,
            pipMargin: this.storageSettings.values.pipMargin ?? 10,
            onNvr: this.isOnNvr,
        } : undefined;

        // For multifocal devices, request a composite snapshot by passing channel=undefined.
        const channelArg = this.isMultiFocal ? undefined : rtspChannel;

        const snapshotBuffer = await client.getSnapshot(
            channelArg,
            {
                onNvr: this.isOnNvr,
                variant: variantType,
                ...(compositeOptions ? { compositeOptions } : {}),
            }
        );
        const mo = await this.createMediaObject(snapshotBuffer, 'image/jpeg');

        return mo;
    }

    async takePicture(options?: RequestPictureOptions) {
        if (!this.isBattery) {
            try {
                return this.withBaichuanRetry(async () => {
                    const client = await this.ensureClient();
                    return await this.takePictureInternal(client);
                });
            } catch (e) {
                this.getBaichuanLogger().error('Error taking snapshot', e?.message || String(e));
                throw e;
            }
        } else {
            const logger = this.getBaichuanLogger();
            let shouldTakeNewSnapshot = this.forceNewSnapshot;

            if (this.lastPicture) {
                const batteryUpdateIntervalMinutes = this.storageSettings.values.batteryUpdateIntervalMinutes ?? 60;
                const updateIntervalMs = batteryUpdateIntervalMinutes * 60_000;
                const timeSinceLastSnapshot = Date.now() - this.lastPicture.atMs;

                if (timeSinceLastSnapshot >= updateIntervalMs) {
                    shouldTakeNewSnapshot = true;
                    logger.log(`Snapshot expired: ${Math.round(timeSinceLastSnapshot / 60_000)} minutes since last snapshot (interval: ${batteryUpdateIntervalMinutes} minutes)`);
                }
            }

            if (!shouldTakeNewSnapshot && this.lastPicture) {
                logger.log(`Returning cached snapshot, taken at ${new Date(this.lastPicture.atMs).toLocaleString()}`);
                return this.lastPicture.mo;
            }

            if (this.takePictureInFlight) {
                return await this.takePictureInFlight;
            }
            this.forceNewSnapshot = false;

            this.takePictureInFlight = (async () => {
                const client = await this.ensureClient();
                await client.wakeUp();
                const mo = await this.takePictureInternal(client);
                this.lastPicture = { mo, atMs: Date.now() };
                logger.log(`Snapshot taken at ${new Date(this.lastPicture.atMs).toLocaleString()}`);
                return mo;
            })();

            try {
                return await this.takePictureInFlight;
            }
            finally {
                this.takePictureInFlight = undefined;
            }
        }
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [];
    }

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

    async updateDeviceInfo(): Promise<void> {
        const logger = this.getBaichuanLogger();

        if (this.multiFocalDevice) {
            this.info = this.multiFocalDevice.info;
            return;
        }

        const { ipAddress, rtspChannel } = this.storageSettings.values;
        try {
            const api = await this.ensureClient();
            const deviceData = await api.getInfo((this.nvrDevice || this.multiFocalDevice) ? rtspChannel : undefined);

            await updateDeviceInfo({
                device: this,
                ipAddress,
                deviceData,
                logger,
            });

        } catch (e) {
            logger.warn('Failed to fetch device info', e?.message || String(e));
        }
    }

    // Device provider methods
    async getDevice(nativeId: string): Promise<any> {
        if (nativeId.endsWith(sirenSuffix)) {
            this.siren ||= new ReolinkCameraSiren(this, nativeId);
            return this.siren;
        } else if (nativeId.endsWith(floodlightSuffix)) {
            this.floodlight ||= new ReolinkCameraFloodlight(this, nativeId);
            return this.floodlight;
        } else if (nativeId.endsWith(pirSuffix)) {
            this.pirSensor ||= new ReolinkCameraPirSensor(this, nativeId);
            return this.pirSensor;
        }
    }

    async release() {
        this.statusPollTimer && clearInterval(this.statusPollTimer);
        this.sleepCheckTimer && clearInterval(this.sleepCheckTimer);
        this.batteryUpdateTimer && clearInterval(this.batteryUpdateTimer);
        this.resetBaichuanClient();
        this.plugin.camerasMap.delete(this.id);
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        if (nativeId.endsWith(sirenSuffix)) {
            this.siren = undefined;
        } else if (nativeId.endsWith(floodlightSuffix)) {
            this.floodlight = undefined;
        } else if (nativeId.endsWith(pirSuffix)) {
            this.pirSensor = undefined;
        }
    }

    async setSirenEnabled(enabled: boolean): Promise<void> {
        const channel = this.storageSettings.values.rtspChannel;

        await this.withBaichuanRetry(async () => {
            const api = await this.ensureClient();
            return await api.setSiren(channel, enabled);
        });
    }

    async setFloodlightState(on?: boolean, brightness?: number): Promise<void> {
        const channel = this.storageSettings.values.rtspChannel;

        await this.withBaichuanRetry(async () => {
            const api = await this.ensureClient();
            return await api.setWhiteLedState(channel, on, brightness);
        });
    }

    async setPirEnabled(enabled: boolean): Promise<void> {
        const channel = this.storageSettings.values.rtspChannel;

        // Get current PIR settings from the sensor if available
        let sensitive: number | undefined;
        let reduceAlarm: number | undefined;
        let interval: number | undefined;

        if (this.pirSensor) {
            sensitive = this.pirSensor.storageSettings.values.sensitive;
            reduceAlarm = this.pirSensor.storageSettings.values.reduceAlarm ? 1 : 0;
            interval = this.pirSensor.storageSettings.values.interval;
        }

        await this.withBaichuanRetry(async () => {
            const api = await this.ensureClient();
            return await api.setPirInfo(channel, {
                enable: enabled ? 1 : 0,
                ...(sensitive !== undefined ? { sensitive } : {}),
                ...(reduceAlarm !== undefined ? { reduceAlarm } : {}),
                ...(interval !== undefined ? { interval } : {}),
            });
        });
    }

    /**
     * Aligns auxiliary device states (siren, floodlight, PIR) with current API state.
     * This should be called periodically for regular cameras and once when battery cameras wake up.
     */
    async alignAuxDevicesState(): Promise<void> {
        const logger = this.getBaichuanLogger();

        const api = await this.ensureClient();

        const channel = this.storageSettings.values.rtspChannel;
        const { hasSiren, hasFloodlight, hasPir } = await this.getAbilities();

        try {
            // Align siren state
            if (hasSiren && this.siren) {
                try {
                    const sirenState = await api.getSiren(channel);
                    this.siren.on = sirenState.enabled;
                } catch (e) {
                    logger.error('Failed to align siren state', e?.message || String(e));
                }
            }

            // Align floodlight state
            if (hasFloodlight && this.floodlight) {
                try {
                    const wl = await api.getWhiteLedState(channel);
                    this.floodlight.on = !!wl.enabled;
                    if (wl.brightness !== undefined) {
                        this.floodlight.brightness = wl.brightness;
                    }
                } catch (e) {
                    logger.error('Failed to align floodlight state', e?.message || String(e));
                }
            }

            // Align PIR state
            if (hasPir && this.pirSensor) {
                try {
                    const pirState = await api.getPirInfo(channel);
                    this.pirSensor.on = pirState.enabled;

                    // Update storage settings with current values from API
                    if (pirState.state) {
                        if (pirState.state.sensitive !== undefined) {
                            this.pirSensor.storageSettings.values.sensitive = pirState.state.sensitive;
                        }
                        if (pirState.state.reduceAlarm !== undefined) {
                            // Convert number (0/1) to boolean
                            this.pirSensor.storageSettings.values.reduceAlarm = !!pirState.state.reduceAlarm;
                        }
                        if (pirState.state.interval !== undefined) {
                            this.pirSensor.storageSettings.values.interval = pirState.state.interval;
                        }
                    }
                } catch (e) {
                    logger.error('Failed to align PIR state', e?.message || String(e));
                }
            }
        } catch (e) {
            logger.error('Failed to align auxiliary devices state', e?.message || String(e));
        }
    }

    // Video stream helper methods
    protected addRtspCredentials(rtspUrl: string): string {
        const logger = this.getBaichuanLogger();

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
            logger.warn('Failed to parse URL for credentials', e?.message || String(e));
            return rtspUrl;
        }
    }

    async getVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        const logger = this.getBaichuanLogger();

        if (this.cachedVideoStreamOptions?.length) {
            return this.cachedVideoStreamOptions;
        }

        // If there's already a fetch in progress, return the existing promise
        if (this.fetchingStreamsPromise) {
            return this.fetchingStreamsPromise;
        }

        // Create and save the promise
        this.fetchingStreamsPromise = (async (): Promise<UrlMediaStreamOptions[]> => {
            try {
                let streams: UrlMediaStreamOptions[] = [];

                const client = await this.ensureClient();

                const { rtspChannel, variantType } = this.storageSettings.values;

                try {

                    const { nativeStreams, rtmpStreams, rtspStreams } = await client.buildVideoStreamOptions({
                        onNvr: this.isOnNvr,
                        channel: rtspChannel,
                        compositeOnly: this.isMultiFocal,
                        lens: variantType,
                    });

                    logger.debug(`Supported streams: ${JSON.stringify({
                        nativeStreams,
                        rtmpStreams,
                        rtspStreams,
                        variantType,
                        onNvr: this.isOnNvr,
                        channel: rtspChannel,
                        compositeOnly: this.isMultiFocal,
                    })}`);

                    // Update preferredStreams choices based on supported stream types
                    const availableChoices = ['Default'];
                    if (nativeStreams.length > 0) availableChoices.push('Native');
                    if (rtspStreams.length > 0) availableChoices.push('RTSP');
                    if (rtmpStreams.length > 0) availableChoices.push('RTMP');

                    this.storageSettings.settings.preferredStreams.choices = availableChoices;

                    // Order streams based on preferredStreams setting
                    const preferredOrder = this.storageSettings.values.preferredStreams || 'Default';
                    let supportedStreams: any[] = [];

                    if (preferredOrder === 'Default') {
                        // Default: RTSP -> RTMP -> Native
                        supportedStreams = [...rtspStreams, ...rtmpStreams, ...nativeStreams];
                    } else if (preferredOrder === 'Native') {
                        supportedStreams = [...nativeStreams, ...rtspStreams, ...rtmpStreams];
                    } else if (preferredOrder === 'RTSP') {
                        supportedStreams = [...rtspStreams, ...rtmpStreams, ...nativeStreams];
                    } else if (preferredOrder === 'RTMP') {
                        supportedStreams = [...rtmpStreams, ...rtspStreams, ...nativeStreams];
                    } else {
                        // Fallback to default
                        supportedStreams = [...rtspStreams, ...rtmpStreams, ...nativeStreams];
                    }

                    for (const supportedStream of supportedStreams) {
                        const { id, metadata, url, name, container, lens, channel, profile, nativeVariant } = supportedStream;

                        // Composite streams are re-encoded to H.264 by the library (ffmpeg/libx264).
                        // Do not infer codec from underlying camera metadata.
                        const isComposite = lens === 'composite' || channel === undefined;
                        const codec = (() => {
                            if (isComposite) return 'h264';

                            const enc = (metadata as any)?.videoEncType;
                            // Many firmwares expose videoEncType as a numeric enum.
                            // Observed: 0 => H.264, 1 => H.265.
                            if (typeof enc === 'number') {
                                if (enc === 0) return 'h264';
                                if (enc === 1) return 'h265';
                            }

                            const s = String(enc ?? '').toLowerCase();
                            if (s === '0') return 'h264';
                            if (s === '1') return 'h265';
                            if (s.includes('264')) return 'h264';
                            if (s.includes('265')) return 'h265';
                            return s;
                        })();

                        // For RTP (native RFC4571), stream identification happens via `id` (streamKey), not URL.
                        const finalUrl = url;

                        streams.push({
                            id,
                            name,
                            url: finalUrl,
                            container,
                            video: { codec, width: metadata.width, height: metadata.height },
                            // audio: { codec: metadata.audioCodec }

                            // Provide explicit RFC4571 metadata so stream-utils can avoid parsing the streamKey.
                            reolinkRfc4571: {
                                channel,
                                profile,
                                variant: nativeVariant,
                            },
                        } as any)
                    }
                } catch (e) {
                    if (!this.isRecoverableBaichuanError?.(e)) {
                        logger.error('Failed to build RTSP/RTMP stream options, falling back to Native', e?.message || String(e));
                    }
                }

                logger.log('Fetched video stream options', streams.map((s) => s.name).join(', '));
                logger.debug(JSON.stringify({ streams }));
                this.cachedVideoStreamOptions = streams;
                return streams;

                return [];
            } finally {
                // Always clear the promise when done (success or failure)
                this.fetchingStreamsPromise = undefined;
            }
        })();

        return this.fetchingStreamsPromise;
    }

    async getVideoStream(vso: RequestMediaStreamOptions): Promise<MediaObject> {
        if (!vso) throw new Error("video streams not set up or no longer exists.");

        const vsos = await this.getVideoStreamOptions();
        const logger = this.getBaichuanLogger();

        logger.debug(`Available streams: ${vsos?.map(s => s.id).join(', ') || 'none'}`);
        logger.debug(`Requested stream ID: '${vso?.id}'`);

        const selected = selectStreamOption(vsos, vso);

        logger.log(`Selected stream: id='${selected.id}', url='${selected.url}'`);

        if (selected.url && (selected.container === 'rtsp' || selected.container === 'rtmp')) {
            const urlWithCredentials = this.addRtspCredentials(selected.url);
            const ret: MediaStreamUrl = {
                container: selected.container,
                url: urlWithCredentials,
                mediaStreamOptions: selected,
            };
            return await this.createMediaObject(ret, ScryptedMimeTypes.MediaStreamUrl);
        }

        // Ensure streamManager is initialized before use
        if (!this.streamManager) {
            const logger = this.getBaichuanLogger();
            logger.warn('StreamManager not initialized, initializing now...');
            this.initStreamManager(logger);
        }

        const streamKey = selected.id;
        if (!streamKey) {
            throw new Error('Missing streamKey (selected.id) for RTP stream');
        }

        logger.log(`Creating RFC4571 stream: streamKey='${streamKey}'`);

        return await this.withBaichuanRetry(async () => {
            return await createRfc4571MediaObjectFromStreamManager({
                streamManager: this.streamManager!,
                streamKey,
                selected,
                sourceId: this.id,
            });
        });
    }

    async ensureClient(): Promise<ReolinkBaichuanApi> {
        if (this.nvrDevice) {
            return await this.nvrDevice.ensureClient();
        }
        if (this.multiFocalDevice) {
            return await this.multiFocalDevice.ensureClient();
        }

        return await this.ensureBaichuanClient();
    }

    async credentialsChanged(): Promise<void> {
        this.cachedVideoStreamOptions = undefined;
    }

    getSelectedPresetId(): number | undefined {
        const s = this.storageSettings.values.ptzSelectedPreset;
        if (!s) return undefined;

        const idPart = s.includes('=') ? s.split('=')[0] : s;
        const id = Number(idPart);
        return Number.isFinite(id) ? id : undefined;
    }

    async refreshDeviceState(): Promise<void> {
        if (this.refreshingState) {
            return;
        }
        this.refreshingState = true;

        const logger = this.getBaichuanLogger();
        const channel = this.storageSettings.values.rtspChannel;

        try {
            const { capabilities, abilities, support, presets, objects } = await this.withBaichuanRetry(async () => {
                const api = await this.ensureClient();
                return await api.getDeviceCapabilities(channel);
            });
            this.classes = objects;
            this.presets = presets;
            this.ptzPresets.setCachedPtzPresets(presets);

            try {
                const { interfaces, type } = getDeviceInterfaces({
                    capabilities,
                    logger: this.console,
                    isLensDevice: !!this.multiFocalDevice,
                });

                const device: Device = {
                    nativeId: this.nativeId,
                    providerNativeId: this.nvrDevice?.nativeId ??
                        this.multiFocalDevice?.nativeId ??
                        this.plugin?.nativeId,
                    name: this.name,
                    interfaces,
                    type,
                    info: this.info,
                };

                await sdk.deviceManager.onDeviceDiscovered(device);

                logger.log(`Device interfaces updated`);
                logger.debug(JSON.stringify({ interfaces, isLensDevice: !!this.multiFocalDevice, hasNvr: !!this.nvrDevice, hasMultiFocal: !!this.multiFocalDevice, hasPlugin: !!this.plugin }));
                logger.debug(`${JSON.stringify(device)}`);
            } catch (e) {
                logger.error('Failed to update device interfaces', e?.message || String(e));
            }

            logger.log(`Refreshed device capabilities`);
            logger.debug(`Refreshed device capabilities: ${JSON.stringify({ capabilities, abilities, support, presets, objects })}`);
        }
        catch (e) {
            logger.error('Failed to refresh abilities', e?.message || String(e));
        }

        this.refreshingState = false;
    }

    async init(): Promise<void> {
        const logger = this.getBaichuanLogger();

        if (this.motionDetected) {
            this.motionDetected = false;
        }

        if (!this.multiFocalDevice) {
            try {
                await this.reportDevices();
            }
            catch (e) {
                logger.warn('Failed to report devices during init', e?.message || String(e));
            }
        }

        this.startPeriodicTasks();
        await this.ensureClient();

        try {
            await this.updateDeviceInfo();
        }
        catch (e) {
            logger.warn('Failed to update device info during init', e?.message || String(e));
        }

        try {
            await this.alignAuxDevicesState();
        }
        catch (e) {
            logger.warn('Failed to align auxiliary devices state during init', e?.message || String(e));
        }

        try {
            await this.refreshDeviceState();
        }
        catch (e) {
            logger.warn('Failed to refresh device state during init', e?.message || String(e));
        }

        if (this.isBattery && !this.multiFocalDevice) {
            await this.updateBatteryInfo();
        }

        this.storageSettings.settings.socketApiDebugLogs.hide = !!this.nvrDevice;
        this.storageSettings.settings.clipsSource.hide = !this.nvrDevice;
        this.storageSettings.settings.clipsSource.defaultValue = this.nvrDevice ? "NVR" : "Device";

        this.storageSettings.settings.diagnosticsRun.hide = !!this.multiFocalDevice;
        this.storageSettings.settings.diagnosticsOutputPath.hide = !!this.multiFocalDevice;

        this.storageSettings.settings.enableVideoclips.hide = !!this.multiFocalDevice;
        this.storageSettings.settings.videoclipsDaysToPreload.hide = !!this.multiFocalDevice;
        this.storageSettings.settings.videoclipsRegularChecks.hide = !!this.multiFocalDevice;
        this.storageSettings.settings.loadVideoclips.hide = !!this.multiFocalDevice;
        this.storageSettings.settings.downloadVideoclipsLocally.hide = !!this.multiFocalDevice;

        this.storageSettings.settings.videoclipsRegularChecks.defaultValue = this.isBattery ? 120 : 30;

        this.storageSettings.settings.batteryUpdateIntervalMinutes.hide = !this.isBattery;
        this.storageSettings.settings.lowThresholdBatteryRecording.hide = !this.isBattery;
        this.storageSettings.settings.highThresholdBatteryRecording.hide = !this.isBattery;

        // Show PIP settings only for multifocal devices
        this.storageSettings.settings.pipPosition.hide = !this.isMultiFocal;
        this.storageSettings.settings.pipSize.hide = !this.isMultiFocal;
        this.storageSettings.settings.pipMargin.hide = !this.isMultiFocal;

        const hideUid = !this.isBattery || this.isOnNvr || !!this.multiFocalDevice
        this.storageSettings.settings.uid.hide = hideUid;
        this.storageSettings.settings.discoveryMethod.hide = hideUid;

        if (this.isBattery && !this.storageSettings.values.mixinsSetup) {
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
                logger.warn('Failed to setup mixins during init', e?.message || String(e));
            }
        }

        try {
            await this.subscribeToEvents();
        }
        catch (e) {
            logger.error('Failed to subscribe to Baichuan events', e?.message || String(e));
        }

        try {
            this.initStreamManager();
        }
        catch (e) {
            logger.error('Failed to initialize StreamManager', e?.message || String(e));
        }

        const { hasIntercom, hasPtz } = await this.getAbilities();

        if (hasIntercom) {
            this.intercom = new ReolinkBaichuanIntercom(this);
        }

        if (hasPtz && !this.multiFocalDevice) {
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

        const parentDevice = this.nvrDevice || this.multiFocalDevice;
        if (parentDevice) {
            this.storageSettings.settings.username.hide = true;
            this.storageSettings.settings.password.hide = true;
            this.storageSettings.settings.ipAddress.hide = true;

            this.storageSettings.settings.username.defaultValue = parentDevice.storageSettings.values.username;
            this.storageSettings.settings.password.defaultValue = parentDevice.storageSettings.values.password;
            this.storageSettings.settings.ipAddress.defaultValue = parentDevice.storageSettings.values.ipAddress;
        }

        this.updateVideoClipsAutoLoad();

        this.onDeviceEvent(ScryptedInterface.Settings, '');
    }

    async updateSleepingState(sleepStatus: SleepStatus): Promise<void> {
        try {
            if (this.isDebugEnabled()) {
                this.getBaichuanLogger().debug('getSleepStatus result:', JSON.stringify(sleepStatus));
            }

            if (sleepStatus.state === 'sleeping') {
                if (!this.sleeping) {
                    this.getBaichuanLogger().log(`Camera is sleeping: ${sleepStatus.reason}`);
                    this.sleeping = true;
                }
            } else if (sleepStatus.state === 'awake') {
                // Camera is awake
                const wasSleeping = this.sleeping;
                if (wasSleeping) {
                    this.getBaichuanLogger().log(`Camera woke up: ${sleepStatus.reason}`);
                    this.sleeping = false;
                }

                if (wasSleeping) {
                    this.alignAuxDevicesState().catch(() => { });
                    if (this.forceNewSnapshot) {
                        this.takePicture().catch(() => { });
                    }
                }
            } else {
                // Unknown state
                this.getBaichuanLogger().debug(`Sleep status unknown: ${sleepStatus.reason}`);
            }
        } catch (e) {
            // Silently ignore errors in sleep check to avoid spam
            this.getBaichuanLogger().debug('Error in updateSleepingState:', e?.message || String(e));
        }
    }

    async updateOnlineState(isOnline: boolean): Promise<void> {
        try {
            if (this.isDebugEnabled()) {
                this.getBaichuanLogger().debug('updateOnlineState result:', isOnline);
            }

            if (isOnline !== this.online) {
                this.online = isOnline;
            }
        } catch (e) {
            // Silently ignore errors in sleep check to avoid spam
            this.getBaichuanLogger().debug('Error in updateOnlineState:', e?.message || String(e));
        }
    }

    async resetBaichuanClient(reason?: any): Promise<void> {
        try {
            this.unsubscribedToEvents?.();
            await this.baichuanApi?.close();
        }
        catch (e) {
            this.getBaichuanLogger().error('Error closing Baichuan client during reset', e?.message || String(e));
        }
        finally {
            this.baichuanApi = undefined;
            this.connectionTime = undefined;
            this.ensureClientPromise = undefined;
        }

        if (reason) {
            const message = reason?.message || reason?.toString?.() || reason;
            this.getBaichuanLogger().error(`Baichuan client reset requested: ${message}`);
        }
    }


    async checkRecordingAction(newBatteryLevel: number) {
        const nvrDeviceId = this.plugin.nvrDeviceId;
        if (nvrDeviceId && this.mixins.includes(nvrDeviceId)) {
            const logger = this.getBaichuanLogger();

            const settings = await this.thisDevice.getSettings();
            const isRecording = !settings.find(setting => setting.key === 'recording:privacyMode')?.value;
            const { lowThresholdBatteryRecording, highThresholdBatteryRecording } = this.storageSettings.values;

            if (isRecording && newBatteryLevel < lowThresholdBatteryRecording) {
                logger.log(`Recording is enabled, but battery level is below low threshold (${newBatteryLevel}% < ${lowThresholdBatteryRecording}%), disabling recording`);
                await this.thisDevice.putSetting('recording:privacyMode', true);
            } else if (!isRecording && newBatteryLevel > highThresholdBatteryRecording) {
                logger.log(`Recording is disabled, but battery level is above high threshold (${newBatteryLevel}% > ${highThresholdBatteryRecording}%), enabling recording`);
                await this.thisDevice.putSetting('recording:privacyMode', false);
            }
        }
    }

    async updateBatteryInfo(batteryInfoParent?: BatteryInfo) {
        const api = await this.ensureClient();
        const channel = this.storageSettings.values.rtspChannel;
        const logger = this.getBaichuanLogger();

        let batteryInfo = batteryInfoParent;
        if (!batteryInfo) {
            batteryInfo = await api.getBatteryInfo(channel);
        }

        if (this.isDebugEnabled()) {
            logger.debug('getBatteryInfo result:', JSON.stringify(batteryInfo));
        }

        if (batteryInfo.batteryPercent !== undefined) {
            const oldLevel = this.batteryLevel;
            this.batteryLevel = batteryInfo.batteryPercent;

            let shouldCheckRecordingAction = true;

            // Log only if battery level changed
            if (oldLevel !== batteryInfo.batteryPercent) {
                if (batteryInfo.chargeStatus !== undefined) {
                    // chargeStatus: "0"=charging, "1"=discharging, "2"=full
                    const charging = batteryInfo.chargeStatus === "0" || batteryInfo.chargeStatus === "2";
                    logger.log(`Battery level changed: ${oldLevel}% → ${batteryInfo.batteryPercent}% (charging: ${charging})`);
                } else {
                    logger.log(`Battery level changed: ${oldLevel}% → ${batteryInfo.batteryPercent}%`);
                }
            } else if (oldLevel === undefined) {
                // First time setting battery level
                if (batteryInfo.chargeStatus !== undefined) {
                    const charging = batteryInfo.chargeStatus === "0" || batteryInfo.chargeStatus === "2";
                    logger.log(`Battery level set: ${batteryInfo.batteryPercent}% (charging: ${charging})`);
                } else {
                    logger.log(`Battery level set: ${batteryInfo.batteryPercent}%`);
                }
            } else {
                shouldCheckRecordingAction = false;
            }

            if (shouldCheckRecordingAction) {
                await this.checkRecordingAction(batteryInfo.batteryPercent);
            }
        }

        return batteryInfo;
    }

    private async updateBatteryAndSnapshot(): Promise<void> {
        const logger = this.getBaichuanLogger();
        if (this.batteryUpdatePromise) {
            logger.debug('Battery update already in progress, returning existing promise');
            return await this.batteryUpdatePromise;
        }

        // Create and save the promise
        this.batteryUpdatePromise = (async (): Promise<void> => {
            try {
                const channel = this.storageSettings.values.rtspChannel;
                const updateIntervalMinutes = this.storageSettings.values.batteryUpdateIntervalMinutes ?? 10;
                logger.log(`Force battery update interval started (every ${updateIntervalMinutes} minutes)`);

                // Ensure we have a client connection
                const api = await this.ensureClient();
                if (!api) {
                    this.getBaichuanLogger().error('Failed to ensure client connection for battery update');
                    return;
                }

                // Check current sleep status
                let sleepStatus = api.getSleepStatus({ channel });

                // If camera is sleeping, wake it up
                if (sleepStatus.state === 'sleeping') {
                    logger.log('Camera is sleeping, waking up for periodic update...');
                    try {
                        await api.wakeUp(channel, { waitAfterWakeMs: 2000 });
                        logger.log('Wake command sent, waiting for camera to wake up...');
                    } catch (wakeError) {
                        logger.error('Failed to wake up camera:', wakeError?.message || String(wakeError));
                        return;
                    }

                    // Poll until camera is awake (with timeout)
                    const wakeTimeoutMs = 30000; // 30 seconds max
                    const startWakePoll = Date.now();
                    let awake = false;

                    while (Date.now() - startWakePoll < wakeTimeoutMs) {
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Check every second
                        sleepStatus = api.getSleepStatus({ channel });
                        if (sleepStatus.state === 'awake') {
                            awake = true;
                            logger.log('Camera is now awake');
                            this.sleeping = false;
                            break;
                        }
                    }

                    if (!awake) {
                        logger.error('Camera did not wake up within timeout, skipping update');
                        return;
                    }
                } else if (sleepStatus.state === 'awake') {
                    this.sleeping = false;
                }

                // Now that camera is awake, update all states
                // 1. Update battery info
                try {
                    await this.updateBatteryInfo();
                } catch (e) {
                    logger.error('Failed to get battery info during periodic update:', e?.message || String(e));
                }

                // 2. Align auxiliary devices state
                try {
                    await this.alignAuxDevicesState();
                } catch (e) {
                    logger.error('Failed to align auxiliary devices state:', e?.message || String(e));
                }

                // 3. Update snapshot
                try {
                    this.forceNewSnapshot = true;
                    await this.takePicture();
                    logger.log('Snapshot updated during periodic update');
                } catch (snapshotError) {
                    logger.error('Failed to update snapshot during periodic update:', snapshotError?.message || String(snapshotError));
                }
            } catch (e) {
                logger.error('Failed to update battery and snapshot', e?.message || String(e));
            } finally {
                // Clear the promise when done (success or failure)
                this.batteryUpdatePromise = undefined;
            }
        })();

        return await this.batteryUpdatePromise;
    }

    startPeriodicTasks(): void {
        const logger = this.getBaichuanLogger();
        if (this.periodicStarted) return;
        this.periodicStarted = true;

        logger.log('Starting periodic tasks');

        if (this.isBattery) {
            if (!this.nvrDevice && !this.multiFocalDevice) {
                this.sleepCheckTimer = setInterval(async () => {
                    try {
                        const api = this.baichuanApi;
                        const channel = this.storageSettings.values.rtspChannel;

                        if (!api) {
                            if (!this.sleeping) {
                                logger.log('Camera is sleeping: no active Baichuan client');
                                this.sleeping = true;
                            }
                            return;
                        }

                        const sleepStatus = api.getSleepStatus({ channel });
                        await this.updateSleepingState(sleepStatus);
                    } catch (e) {
                        logger.error('Error checking sleeping state:', e?.message || String(e));
                    }
                }, 5_000);
            }

            // Update battery and snapshot every N minutes
            const { batteryUpdateIntervalMinutes = 10 } = this.storageSettings.values;
            const updateIntervalMs = batteryUpdateIntervalMinutes * 60_000;
            this.batteryUpdateTimer = setInterval(async () => {
                try {
                    await this.updateBatteryAndSnapshot();
                } catch (e) {
                    logger.error('Error updating battery and snapshot:', e?.message || String(e));
                }
            }, updateIntervalMs);

            logger.log(`Periodic tasks started: sleep check every 5s, battery update every ${batteryUpdateIntervalMinutes} minutes`);
        } else {
            this.statusPollTimer = setInterval(async () => {
                try {
                    await this.alignAuxDevicesState();
                } catch (e) {
                    logger.error('Error aligning auxiliary devices state:', e?.message || String(e));
                }
            }, 10_000);

            logger.log('Periodic tasks started: status poll every 10s');
        }
    }
}
