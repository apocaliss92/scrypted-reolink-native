import type { DeviceCapabilities, PtzCommand, PtzPreset, ReolinkBaichuanApi, ReolinkSimpleEvent, ReolinkSupportedStream, StreamProfile, StreamSamplingSelection } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { BinarySensor, Brightness, Camera, Device, DeviceProvider, Intercom, MediaObject, MediaStreamUrl, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, OnOff, PanTiltZoom, PanTiltZoomCommand, Reboot, RequestMediaStreamOptions, RequestPictureOptions, ResponsePictureOptions, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions, VideoTextOverlay, VideoTextOverlays } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { spawn } from 'node:child_process';
import http from 'http';
import https from 'https';
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
    createRfc4571CompositeMediaObjectFromStreamManager,
    createRfc4571MediaObjectFromStreamManager,
    expectedVideoTypeFromUrlMediaStreamOptions,
    parseStreamProfileFromId,
    selectStreamOption,
    StreamManager
} from "./stream-utils";
import { floodlightSuffix, getDeviceInterfaces, getVideoClipWebhookUrls, pirSuffix, recordingFileToVideoClip, sanitizeFfmpegOutput, sirenSuffix, updateDeviceInfo, vodSearchResultsToVideoClips } from "./utils";

export type CameraType = 'battery' | 'regular' | 'multi-focal' | 'multi-focal-battery';

export interface CommonCameraMixinOptions {
    type: CameraType;
    nvrDevice?: ReolinkNativeNvrDevice; // Optional reference to NVR device
    multiFocalDevice?: ReolinkNativeMultiFocalDevice; // Optional reference to multi-focal device
}

class ReolinkCameraSiren extends ScryptedDeviceBase implements OnOff {
    constructor(public camera: CommonCameraMixin, nativeId: string) {
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
            this.camera.getBaichuanLogger().warn(`Siren toggle: turnOff failed (device=${this.nativeId})`, e);
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
            this.camera.getBaichuanLogger().warn(`Siren toggle: turnOn failed (device=${this.nativeId})`, e);
            throw e;
        }
    }
}

class ReolinkCameraFloodlight extends ScryptedDeviceBase implements OnOff, Brightness {
    constructor(public camera: CommonCameraMixin, nativeId: string) {
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
            this.camera.getBaichuanLogger().warn(`Floodlight toggle: setBrightness failed (device=${this.nativeId} brightness=${brightness})`, e);
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
            this.camera.getBaichuanLogger().warn(`Floodlight toggle: turnOff failed (device=${this.nativeId})`, e);
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
            this.camera.getBaichuanLogger().warn(`Floodlight toggle: turnOn failed (device=${this.nativeId})`, e);
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

    constructor(public camera: CommonCameraMixin, nativeId: string) {
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

export abstract class CommonCameraMixin extends BaseBaichuanClass implements VideoCamera, Camera, Settings, DeviceProvider, ObjectDetector, PanTiltZoom, VideoTextOverlays, BinarySensor, Intercom, Reboot, VideoClips {
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
        multifocalInfo: {
            json: true,
            hide: true,
        },
        // Multifocal composite stream PIP settings
        pipPosition: {
            title: 'PIP Position',
            description: 'Position of the tele lens overlay on the wider lens view',
            type: 'string',
            defaultValue: 'bottom-right',
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
            hide: true,
            onPut: async () => {
                this.scheduleStreamManagerRestart('pipSize changed');
            },
        },
        pipMargin: {
            title: 'PIP Margin',
            description: 'Margin from edge in pixels',
            type: 'number',
            defaultValue: 10,
            hide: true,
            onPut: async () => {
                this.scheduleStreamManagerRestart('pipMargin changed');
            },
        },
        widerChannel: {
            title: 'Wider Channel',
            description: 'Channel number for wider lens (typically 0)',
            type: 'number',
            defaultValue: 0,
            hide: true,
            onPut: async () => {
                this.scheduleStreamManagerRestart('widerChannel changed');
            },
        },
        teleChannel: {
            title: 'Tele Channel',
            description: 'Channel number for tele lens (typically 1)',
            type: 'number',
            defaultValue: 1,
            hide: true,
            onPut: async () => {
                this.scheduleStreamManagerRestart('teleChannel changed');
            },
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
        debugLogs: {
            title: 'Debug logs',
            type: 'boolean',
            immediate: true,
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
                            logger.warn('Failed to reset client after debug logs change', e);
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
            defaultValue: path.join(process.env.SCRYPTED_PLUGIN_VOLUME, 'diagnostics', this.name),
        },
        enableVideoclips: {
            title: "Enable Video Clips",
            description: "Enable video clips functionality. If disabled, getVideoClips will return empty and all other videoclip settings are ignored.",
            type: "boolean",
            defaultValue: false,
            immediate: true,
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
        },
        loadVideoclips: {
            title: "Auto-load Video Clips",
            subgroup: 'Videoclips',
            description: "Automatically fetch today's video clips and download missing thumbnails at regular intervals.",
            type: "boolean",
            defaultValue: false,
            immediate: true,
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
            onPut: async () => {
                this.updateVideoClipsAutoLoad();
            },
        },
        diagnosticsRun: {
            subgroup: 'Diagnostics',
            title: 'Run Diagnostics',
            description: 'Run all diagnostics and save results to the output path.',
            type: 'button',
            immediate: true,
            onPut: async () => {
                await this.runDiagnostics();
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

    // Video stream properties
    protected cachedVideoStreamOptions?: UrlMediaStreamOptions[];
    protected fetchingStreams = false;
    protected lastNetPortCacheAttempt: number = 0;
    protected netPortCacheBackoffMs: number = 5000; // 5 seconds backoff on failure

    // Client management (inherited from BaseBaichuanClass)
    protected readonly protocol: BaichuanTransport;
    private debugLogsResetTimeout: NodeJS.Timeout | undefined;

    // Abstract init method that subclasses must implement
    abstract init(): Promise<void>;

    motionTimeout?: NodeJS.Timeout;
    doorbellBinaryTimeout?: NodeJS.Timeout;
    initComplete?: boolean;
    resetBaichuanClient?(reason?: any): Promise<void>;

    protected nvrDevice?: ReolinkNativeNvrDevice;
    protected multiFocalDevice?: ReolinkNativeMultiFocalDevice;
    thisDevice: Settings;
    isBattery: boolean;
    isMultiFocal: boolean;
    private streamManagerRestartTimeout: NodeJS.Timeout | undefined;
    private videoClipsAutoLoadInterval: NodeJS.Timeout | undefined;
    private videoClipsAutoLoadInProgress: boolean = false;
    private videoClipsAutoLoadMode: boolean = false;

    constructor(
        nativeId: string,
        public plugin: ReolinkNativePlugin,
        public options: CommonCameraMixinOptions
    ) {
        super(nativeId);
        this.plugin.mixinsMap.set(this.id, this);

        // Store NVR device reference if provided
        this.nvrDevice = options.nvrDevice;
        this.multiFocalDevice = options.multiFocalDevice;
        this.thisDevice = sdk.systemManager.getDeviceById<Settings>(this.id);

        this.isBattery = options.type === 'battery' || options.type === 'multi-focal-battery';
        this.isMultiFocal = options.type === 'multi-focal' || options.type === 'multi-focal-battery';
        this.protocol = this.isBattery ? 'udp' : 'tcp';

        setTimeout(async () => {
            await this.parentInit();
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

        // Skip sleeping check during auto-load to allow auto-load to start for battery cameras
        if (!this.videoClipsAutoLoadMode && this.isBattery && this.sleeping) {
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
        // Use UTC to match API's dateToReolinkTime conversion
        start.setUTCHours(0, 0, 0, 0);

        try {
            const { clipsSource } = this.storageSettings.values;
            const useNvr = clipsSource === "NVR" && this.nvrDevice;

            const api = await this.ensureClient();

            if (useNvr) {
                // Fetch from NVR using listEnrichedVodFiles (library handles parsing correctly)
                const channel = this.storageSettings.values.rtspChannel ?? 0;

                // Use listEnrichedVodFiles which properly parses filenames and extracts detection info
                logger.debug(`[NVR VOD] Searching for video clips: channel=${channel}, start=${start.toISOString()}, end=${end.toISOString()}`);
                // Filter to only include recordings within the requested time window
                const enrichedRecordings = await api.listNvrRecordings({
                    channel,
                    start,
                    end,
                    streamType: "main",
                });

                logger.debug(`[NVR VOD] Found ${enrichedRecordings.length} enriched recordings from NVR`);

                // Log sample of enriched recordings to see what the library returned
                if (enrichedRecordings.length > 0) {
                    const sampleSize = Math.min(3, enrichedRecordings.length);
                    for (let i = 0; i < sampleSize; i++) {
                        const rec = enrichedRecordings[i];
                        logger.debug(`[NVR VOD] Sample enriched recording ${i + 1}/${enrichedRecordings.length}:`, {
                            fileName: rec.fileName,
                            startTimeMs: rec.startTimeMs,
                            endTimeMs: rec.endTimeMs,
                            durationMs: rec.durationMs,
                            hasPerson: rec.hasPerson,
                            hasVehicle: rec.hasVehicle,
                            hasAnimal: rec.hasAnimal,
                            hasFace: rec.hasFace,
                            hasMotion: rec.hasMotion,
                            hasDoorbell: rec.hasDoorbell,
                            hasPackage: rec.hasPackage,
                            recordType: rec.recordType,
                            parsedFileName: rec.parsedFileName ? {
                                start: rec.parsedFileName.start?.toISOString(),
                                end: rec.parsedFileName.end?.toISOString(),
                                flags: rec.parsedFileName.flags,
                            } : null,
                        });
                    }
                }

                // Convert enriched recordings to VideoClip array
                const clips: VideoClip[] = [];

                for (const rec of enrichedRecordings) {
                    // Log detection flags before conversion
                    const flags = {
                        hasPerson: 'hasPerson' in rec ? rec.hasPerson : false,
                        hasVehicle: 'hasVehicle' in rec ? rec.hasVehicle : false,
                        hasAnimal: 'hasAnimal' in rec ? rec.hasAnimal : false,
                        hasFace: 'hasFace' in rec ? rec.hasFace : false,
                        hasMotion: 'hasMotion' in rec ? rec.hasMotion : false,
                        hasDoorbell: 'hasDoorbell' in rec ? rec.hasDoorbell : false,
                        hasPackage: 'hasPackage' in rec ? rec.hasPackage : false,
                        recordType: rec.recordType || 'none',
                    };
                    logger.debug(`[NVR VOD] Processing recording: fileName=${rec.fileName}, flags=${JSON.stringify(flags)}`);

                    const clip = await recordingFileToVideoClip(rec, {
                        fallbackStart: start,
                        logger,
                        plugin: this,
                        deviceId: this.id,
                        useWebhook: true,
                    });

                    // Log detection classes in the final clip
                    logger.debug(`[NVR VOD] Generated clip: id=${clip.id}, detectionClasses=${clip.detectionClasses?.join(',') || 'none'}`);
                    clips.push(clip);
                }

                // Apply count limit if specified
                const finalClips = count ? clips.slice(0, count) : clips;
                logger.debug(`[NVR VOD] Converted ${finalClips.length} video clips (limit: ${count || 'none'})`);

                return finalClips;
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

                const clips: VideoClip[] = [];

                for (const rec of recordings) {
                    const clip = await recordingFileToVideoClip(rec, {
                        fallbackStart: start,
                        api,
                        logger,
                        plugin: this,
                        deviceId: this.id,
                        useWebhook: true,
                    });
                    clips.push(clip);
                }

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
                        logger.warn(`[VideoClip] Failed to delete small cached file: fileId=${videoId}`, unlinkErr);
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

            const { clipsSource } = this.storageSettings.values;
            const useNvr = clipsSource === "NVR" && this.nvrDevice && videoId.includes('/');

            // NVR/HUB case: prefer Download endpoint (HTTP) instead of RTMP
            if (useNvr && this.nvrDevice) {
                // Reuse centralized logic for NVR VOD URL (Download)
                const downloadUrl = await this.getVideoClipRtmpUrl(videoId);

                // If caching is enabled, download via HTTP and cache as file
                if (cacheEnabled) {
                    const cachePath = this.getVideoClipCachePath(videoId);
                    logger.log(`Downloading video clip from NVR to cache: fileId=${videoId}, path=${cachePath}`);

                    await new Promise<void>((resolve, reject) => {
                        const urlObj = new URL(downloadUrl);
                        const httpModule = urlObj.protocol === 'https:' ? https : http;

                        const fileStream = fs.createWriteStream(cachePath);

                        const req = httpModule.get(downloadUrl, (res) => {
                            if (!res.statusCode || res.statusCode >= 400) {
                                reject(new Error(`NVR download failed: ${res.statusCode} ${res.statusMessage}`));
                                return;
                            }

                            res.pipe(fileStream);

                            res.on('error', (err) => {
                                reject(err);
                            });

                            fileStream.on('finish', () => {
                                resolve();
                            });

                            fileStream.on('error', (err) => {
                                reject(err);
                            });
                        });

                        req.on('error', (err) => {
                            reject(err);
                        });
                    });

                    const mo = await sdk.mediaManager.createMediaObjectFromUrl(`file://${cachePath}`);
                    return mo;
                } else {
                    // Caching disabled: return HTTP Download URL directly
                    const mo = await sdk.mediaManager.createMediaObjectFromUrl(downloadUrl);
                    return mo;
                }
            }

            // Standalone camera (or fallback): reuse getVideoClipRtmpUrl (Baichuan RTMP)
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
                        logger.error(`ffmpeg spawn error for video clip ${videoId}`, error);
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
            logger.error(`getVideoClip: failed to get video clip ${videoId}`, e);
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
                        logger.warn(`[Thumbnail] Failed to delete small cached thumbnail: fileId=${thumbnailId}`, unlinkErr);
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
                logger.warn(`[Thumbnail] Failed to cache: fileId=${thumbnailId}`, e);
                // Continue even if caching fails
            }

            return thumbnail;
        } catch (e) {
            logger.error(`[Thumbnail] Error: fileId=${thumbnailId}`, e);
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
        const useNvr = clipsSource === "NVR" && this.nvrDevice && fileId.includes('/');

        if (useNvr) {
            logger.debug(`[getVideoClipRtmpUrl] Using NVR API for fileId="${fileId}", forThumbnail=${forThumbnail}`);
            const api = await this.ensureClient();
            const channel = this.storageSettings.values.rtspChannel ?? 0;

            try {
                logger.debug(`[getVideoClipRtmpUrl] Trying getVodUrl with Download requestType...`);
                const url = await api.getVodUrl(fileId, channel, {
                    requestType: "Download",
                    streamType: "main",
                });
                logger.debug(`[getVideoClipRtmpUrl] NVR getVodUrl Download URL received: url="${url || 'none'}"`);
                if (url) return url;
            } catch (e: any) {
                logger.error(`[getVideoClipRtmpUrl] getVodUrl Download failed: ${e.message}`);
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
        this.videoClipsAutoLoadMode = true;

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
            logger.error('Error during auto-loading video clips:', e);
        } finally {
            this.videoClipsAutoLoadInProgress = false;
            this.videoClipsAutoLoadMode = false;
        }
    }

    async reboot(): Promise<void> {
        const api = await this.ensureBaichuanClient();
        await api.reboot();
    }

    // BaseBaichuanClass abstract methods implementation
    protected getConnectionConfig(): BaichuanConnectionConfig {
        const { ipAddress, username, password, uid } = this.storageSettings.values;
        const debugOptions = this.getBaichuanDebugOptions();
        const normalizedUid = this.isBattery ? normalizeUid(uid) : undefined;

        if (this.isBattery && !normalizedUid) {
            throw new Error('UID is required for battery cameras (BCUDP)');
        }

        const logger = this.getBaichuanLogger();
        return {
            host: ipAddress,
            username,
            password,
            uid: normalizedUid,
            transport: this.protocol,
            logger,
            debugOptions,
        };
    }

    protected getConnectionCallbacks(): BaichuanConnectionCallbacks {
        return {
            onError: undefined, // Use default error handling
            onClose: async () => {
                // Reset client state on close
                // The base class already handles cleanup
                // For battery cameras, don't auto-resubscribe after idle disconnects
                // (idle disconnects are normal for battery cameras to save power)
                // Events will be resubscribed when ensureClient() is called for actual operations
                if (!this.isBattery) {
                    // For non-battery cameras, resubscribe to events after reconnection
                    setTimeout(async () => {
                        try {
                            await this.subscribeToEvents();
                        } catch (e) {
                            const logger = this.getBaichuanLogger();
                            logger.warn('Failed to resubscribe to events after reconnection', e);
                        }
                    }, 1000);
                }
            },
            onSimpleEvent: this.onSimpleEvent,
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
        return await fn();

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

            const result = await api.runAllDiagnosticsConsecutively({
                outDir: outputPath,
                channel,
                durationSeconds,
                selection,
            });

            logger.log(`Diagnostics completed successfully. Output directory: ${result.runDir}`);
            logger.log(`Diagnostics file: ${result.diagnosticsPath}`);
            logger.log(`Streams directory: ${result.streamsDir}`);
        } catch (e) {
            logger.error('Failed to run diagnostics', e);
            throw e;
        }
    }

    protected async onBeforeCleanup(): Promise<void> {
        // Unsubscribe from events if needed
        if (this.onSimpleEvent && this.baichuanApi) {
            try {
                this.baichuanApi.offSimpleEvent(this.onSimpleEvent);
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
    async createStreamClient(profile?: StreamProfile): Promise<ReolinkBaichuanApi> {
        // Battery / BCUDP path: reuse the main client to avoid extra wake-ups and sockets.
        if (this.isBattery) {
            return await this.ensureClient();
        }

        // For TCP path: create a new client ONLY for "ext" profile
        // For other profiles (main, sub), reuse the main client
        if (profile !== 'ext') {
            return await this.ensureClient();
        }

        // TCP path with ext profile: create a separate session for streaming (RFC4571/composite/NVR-friendly).
        const { ipAddress, username, password } = this.storageSettings.values;
        const logger = this.getBaichuanLogger();

        const debugOptions = this.getBaichuanDebugOptions();
        const api = await createBaichuanApi(
            {
                inputs: {
                    host: ipAddress,
                    username,
                    password,
                    logger,
                    debugOptions,
                },
                transport: 'tcp',
            },
        );

        await api.login();
        return api;
    }

    public getAbilities(): DeviceCapabilities {
        if (this.multiFocalDevice) {
            return this.multiFocalDevice.getInterfaces(this.storageSettings.values.rtspChannel).capabilities;
        } else {
            return this.storageSettings.values.capabilities;
        }
    }

    getBaichuanDebugOptions(): any | undefined {
        const socketDebugLogs = this.storageSettings.values.socketApiDebugLogs || [];
        return convertDebugLogsToApiOptions(socketDebugLogs);
    }

    /**
     * Initialize or recreate the StreamManager, taking into account multifocal composite options.
     */
    protected initStreamManager(logger: Console, forceRecreate: boolean = false): void {
        const { username, password } = this.storageSettings.values;

        const baseOptions: any = {
            createStreamClient: (profile?: StreamProfile) => this.createStreamClient(profile),
            getLogger: () => logger,
            credentials: {
                username,
                password,
            },
            sharedConnection: this.isBattery,
        };

        if (this.isMultiFocal) {
            const values: any = this.storageSettings.values;
            const pipPosition = values.pipPosition || 'bottom-right';
            const pipSize = values.pipSize ?? 0.25;
            const pipMargin = values.pipMargin ?? 10;
            const widerChannel = values.widerChannel ?? 0;
            const teleChannel = values.teleChannel ?? 1;

            baseOptions.compositeOptions = {
                widerChannel,
                teleChannel,
                pipPosition,
                pipSize,
                pipMargin,
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
            const restartLogger = this.getBaichuanLogger();
            try {
                restartLogger.log('Restarting StreamManager due to PIP/composite settings change');
                this.initStreamManager(restartLogger, true);

                // Invalidate snapshot cache for battery/multifocal-battery so that
                // the next snapshot reflects the new PIP/composite configuration.
                if (this.isBattery) {
                    this.forceNewSnapshot = true;
                    this.lastPicture = undefined;
                }

                // Notify consumers (e.g. prebuffer) that stream configuration changed.
                try {
                    this.onDeviceEvent(ScryptedInterface.VideoCamera, undefined);
                } catch {
                    // best-effort
                }
            } catch (e) {
                restartLogger.warn('Failed to restart StreamManager after settings change', e);
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
        this.unsubscribeFromEvents().catch(() => {
        });

        if (this.motionDetected) {
            this.motionDetected = false;
        }
    }

    onSimpleEvent = (ev: ReolinkSimpleEvent) => {
        const logger = this.getBaichuanLogger();

        try {
            const logger = this.getBaichuanLogger();

            logger.debug(`Baichuan event: ${JSON.stringify(ev)}`);

            if (!this.isEventDispatchEnabled()) {
                logger.debug('Event dispatch is disabled, ignoring event');
                return;
            }

            const channel = this.storageSettings.values.rtspChannel;
            if (ev?.channel !== undefined && ev.channel !== channel) {
                logger.error(`Event channel ${ev.channel} does not match camera channel ${channel}, ignoring`);
                return;
            }

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
                    logger.error(`Unknown event type: ${ev?.type}`);
                    return;
            }

            this.processEvents({ motion, objects }).catch((e) => {
                logger.warn('Error processing events', e);
            });
        }
        catch (e) {
            logger.warn('Error in onSimpleEvent handler', e);
        }
    }

    async subscribeToEvents(): Promise<void> {
        if (this.nvrDevice || this.multiFocalDevice) {
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

        const api = await this.ensureClient();

        try {
            await api.onSimpleEvent(this.onSimpleEvent);
            logger.log(`Subscribed to events (${selection.join(', ')}) on ${this.protocol} connection`);
        }
        catch (e) {
            logger.warn('Failed to attach Baichuan event handler', e);
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

    async reportDevices(): Promise<void> {
        const abilities = this.getAbilities();

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

    async takePicture(options?: RequestPictureOptions) {
        if (!this.isBattery) {
            try {
                return this.withBaichuanRetry(async () => {
                    const client = await this.ensureClient();
                    const snapshotBuffer = await client.getSnapshot(this.storageSettings.values.rtspChannel);
                    const mo = await this.createMediaObject(snapshotBuffer, 'image/jpeg');

                    return mo;
                });
            } catch (e) {
                this.getBaichuanLogger().error('Error taking snapshot', e);
                throw e;
            }
        } else {
            const logger = this.getBaichuanLogger();
            const shouldTakeNewSnapshot = this.forceNewSnapshot;

            if (!shouldTakeNewSnapshot && this.lastPicture) {
                logger.log(`Returning cached snapshot, taken at ${new Date(this.lastPicture.atMs).toLocaleString()}`);
                return this.lastPicture.mo;
            }

            if (this.takePictureInFlight) {
                return await this.takePictureInFlight;
            }

            logger.log(`Taking new snapshot from camera (forceNewSnapshot: ${this.forceNewSnapshot})`);
            this.forceNewSnapshot = false;

            this.takePictureInFlight = (async () => {
                const channel = this.storageSettings.values.rtspChannel;
                const snapshotBuffer = await this.withBaichuanClient(async (api) => {
                    return await api.getSnapshot(channel);
                });
                const mo = await sdk.mediaManager.createMediaObject(snapshotBuffer, 'image/jpeg');
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
            logger.warn('Failed to fetch device info', e);
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
        this.plugin.mixinsMap.delete(this.id);
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

        const api = this.baichuanApi;
        if (!api) return;

        const channel = this.storageSettings.values.rtspChannel;
        const { hasSiren, hasFloodlight, hasPir } = this.getAbilities();

        try {
            // Align siren state
            if (hasSiren && this.siren) {
                try {
                    const sirenState = await api.getSiren(channel);
                    this.siren.on = sirenState.enabled;
                } catch (e) {
                    logger.debug('Failed to align siren state', e);
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
                    logger.debug('Failed to align floodlight state', e);
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
                    logger.debug('Failed to align PIR state', e);
                }
            }
        } catch (e) {
            logger.debug('Failed to align auxiliary devices state', e);
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
            logger.warn('Failed to parse URL for credentials', e);
            return rtspUrl;
        }
    }

    async getVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        const logger = this.getBaichuanLogger();

        if (this.cachedVideoStreamOptions?.length) {
            return this.cachedVideoStreamOptions;
        }

        if (this.fetchingStreams) {
            return [];
        }

        this.fetchingStreams = true;

        let streams: UrlMediaStreamOptions[] = [];

        const client = await this.ensureClient();

        // For multifocal devices, use undefined channel to get composite streams
        const isMultiFocal = this.options.type === 'multi-focal' || this.options.type === 'multi-focal-battery';
        const channel = isMultiFocal ? undefined : this.storageSettings.values.rtspChannel;

        try {
            const { nativeStreams, rtmpStreams, rtspStreams } = await client.buildVideoStreamOptions(channel);

            let supportedStreams: ReolinkSupportedStream[] = [];
            // Homehub RTMP is not efficient, crashes, offers native streams to not overload the hub
            // if (this.nvrDevice && this.nvrDevice.info.model === 'HOMEHUB') {
            supportedStreams = [...nativeStreams, ...rtspStreams, ...rtmpStreams];
            // } else {
            //     supportedStreams = [...rtspStreams, ...rtmpStreams, ...nativeStreams];
            // }

            for (const supportedStream of supportedStreams) {
                const { id, metadata, url, name, container } = supportedStream;

                const codec = String(metadata.videoEncType || "").includes("264")
                    ? "h264"
                    : String(metadata.videoEncType || "").includes("265")
                        ? "h265"
                        : String(metadata.videoEncType || "").toLowerCase();

                streams.push({
                    id,
                    name,
                    url,
                    container,
                    video: { codec, width: metadata.width, height: metadata.height },
                    // audio: { codec: metadata.audioCodec }
                })
            }
        } catch (e) {
            if (!this.isRecoverableBaichuanError?.(e)) {
                logger.warn('Failed to build RTSP/RTMP stream options, falling back to Native', e);
            }
        }

        if (streams.length) {
            logger.log('Fetched video stream options', streams.map((s) => s.name).join(', '));
            logger.debug(JSON.stringify(streams));
            this.cachedVideoStreamOptions = streams;
            return streams;
        }

        this.fetchingStreams = false;
    }

    async getVideoStream(vso: RequestMediaStreamOptions): Promise<MediaObject> {
        if (!vso) throw new Error("video streams not set up or no longer exists.");

        const vsos = await this.getVideoStreamOptions();
        const selected = selectStreamOption(vsos, vso);

        if (selected.url && (selected.container === 'rtsp' || selected.container === 'rtmp')) {
            const urlWithCredentials = this.addRtspCredentials(selected.url);
            const ret: MediaStreamUrl = {
                container: selected.container,
                url: urlWithCredentials,
                mediaStreamOptions: selected,
            };
            return await this.createMediaObject(ret, ScryptedMimeTypes.MediaStreamUrl);
        }

        if (!this.streamManager) {
            throw new Error('StreamManager not initialized');
        }

        // Check if this is a composite stream request (for multifocal devices)
        const isComposite = selected.id?.startsWith('composite_');
        if (isComposite && this.options && (this.options.type === 'multi-focal' || this.options.type === 'multi-focal-battery')) {
            const profile = parseStreamProfileFromId(selected.id.replace('composite_', '')) || 'main';
            const streamKey = `composite_${profile}`;
            const expectedVideoType = expectedVideoTypeFromUrlMediaStreamOptions(selected);

            const createStreamFn = async () => {
                return await createRfc4571CompositeMediaObjectFromStreamManager({
                    streamManager: this.streamManager!,
                    profile,
                    streamKey,
                    expectedVideoType,
                    selected,
                    sourceId: this.id,
                });
            };

            return await this.withBaichuanRetry(createStreamFn);
        }

        // Regular stream for single channel
        const profile = parseStreamProfileFromId(selected.id) || 'main';
        const channel = this.storageSettings.values.rtspChannel;
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
                // onDetectedCodec: (detectedCodec) => {
                //     const prev = this.cachedVideoStreamOptions ?? [];
                //     const next = prev.filter((s) => s.id !== nativeId);
                //     next.push({
                //         container: 'rtp',
                //         video: { codec: detectedCodec },
                //         url: ``
                //     });
                //     this.cachedVideoStreamOptions = next;
                // },
            });
        };

        return await this.withBaichuanRetry(createStreamFn);
    }

    async ensureClient(): Promise<ReolinkBaichuanApi> {
        if (this.nvrDevice) {
            return await this.nvrDevice.ensureBaichuanClient();
        }
        if (this.multiFocalDevice) {
            return await this.multiFocalDevice.ensureBaichuanClient();
        }

        // Use base class implementation
        return await this.ensureBaichuanClient();
    }

    async credentialsChanged(): Promise<void> {
        this.cachedVideoStreamOptions = undefined;
    }

    // PTZ Presets methods
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
                logger.debug(`${JSON.stringify(device)}`);
            } catch (e) {
                logger.error('Failed to update device interfaces', e);
            }

            logger.log(`Refreshed device capabilities: ${JSON.stringify(capabilities)}`);
            logger.debug(`Refreshed device capabilities: ${JSON.stringify({ abilities, support, presets, objects })}`);
        }
        catch (e) {
            logger.error('Failed to refresh abilities', e);
        }

        this.refreshingState = false;
    }

    async parentInit(): Promise<void> {
        const logger = this.getBaichuanLogger();

        try {
            await this.ensureClient();
            await this.updateDeviceInfo();
        }
        catch (e) {
            logger.warn('Failed to update device info during init', e);
        }

        if (!this.multiFocalDevice) {
            try {
                await this.refreshDeviceState();
                await this.reportDevices();
            }
            catch (e) {
                logger.warn('Failed to connect/refresh during init', e);
            }
        }
        this.storageSettings.settings.clipsSource.hide = !this.nvrDevice;
        this.storageSettings.settings.clipsSource.defaultValue = this.nvrDevice ? "NVR" : "Device";

        this.storageSettings.settings.videoclipsRegularChecks.defaultValue = this.isBattery ? 120 : 30;

        this.storageSettings.settings.batteryUpdateIntervalMinutes.hide = !this.isBattery;
        this.storageSettings.settings.lowThresholdBatteryRecording.hide = !this.isBattery;
        this.storageSettings.settings.highThresholdBatteryRecording.hide = !this.isBattery;

        // Show PIP settings only for multifocal devices
        this.storageSettings.settings.pipPosition.hide = !this.isMultiFocal;
        this.storageSettings.settings.pipSize.hide = !this.isMultiFocal;
        this.storageSettings.settings.pipMargin.hide = !this.isMultiFocal;
        this.storageSettings.settings.widerChannel.hide = !this.isMultiFocal;
        this.storageSettings.settings.teleChannel.hide = !this.isMultiFocal;

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
                logger.warn('Failed to setup mixins during init', e);
            }
        }

        try {
            await this.subscribeToEvents();
        }
        catch (e) {
            logger.warn('Failed to subscribe to Baichuan events', e);
        }

        // Initialize StreamManager (with composite options for multifocal devices)
        this.initStreamManager(logger);

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

        if (this.nvrDevice || this.multiFocalDevice) {
            this.storageSettings.settings.username.hide = true;
            this.storageSettings.settings.password.hide = true;
            this.storageSettings.settings.ipAddress.hide = true;

            this.storageSettings.settings.username.defaultValue = this.nvrDevice.storageSettings.values.username;
            this.storageSettings.settings.password.defaultValue = this.nvrDevice.storageSettings.values.password;
            this.storageSettings.settings.ipAddress.defaultValue = this.nvrDevice.storageSettings.values.ipAddress;
        }

        await this.init();

        this.initComplete = true;

        // Initialize video clips auto-load if enabled
        this.updateVideoClipsAutoLoad();
    }
}


