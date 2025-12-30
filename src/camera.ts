import type { BatteryInfo, PtzCommand, ReolinkBaichuanApi, StreamProfile } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { Brightness, Camera, Device, DeviceProvider, FFmpegInput, Intercom, MediaObject, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, OnOff, PanTiltZoom, PanTiltZoomCommand, RequestMediaStreamOptions, RequestPictureOptions, ResponseMediaStreamOptions, ResponsePictureOptions, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, Sleep, VideoCamera, VideoTextOverlay, VideoTextOverlays } from "@scrypted/sdk";
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { UrlMediaStreamOptions } from "../../scrypted/plugins/rtsp/src/rtsp";
import ReolinkNativePlugin from "./main";
import { parseStreamProfileFromId, StreamManager } from './stream-utils';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

class WavDataExtractor {
    private buffer: Buffer = Buffer.alloc(0);
    private inData = false;
    private bytesRemaining: number | undefined;

    push(chunk: Buffer): Buffer[] {
        if (chunk.length === 0) return [];
        if (this.inData) {
            if (this.bytesRemaining === undefined) return [chunk];
            if (this.bytesRemaining <= 0) return [];
            const take = Math.min(this.bytesRemaining, chunk.length);
            this.bytesRemaining -= take;
            return take > 0 ? [chunk.subarray(0, take)] : [];
        }

        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        const out: Buffer[] = [];

        // Need RIFF header
        if (this.buffer.length < 12) return out;
        if (this.buffer.toString('ascii', 0, 4) !== 'RIFF' || this.buffer.toString('ascii', 8, 12) !== 'WAVE') {
            // If ffmpeg ever emits garbage, try to resync by finding RIFF.
            const idx = this.buffer.indexOf(Buffer.from('RIFF'));
            if (idx === -1) {
                this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 3));
                return out;
            }
            this.buffer = this.buffer.subarray(idx);
            if (this.buffer.length < 12) return out;
            if (this.buffer.toString('ascii', 0, 4) !== 'RIFF' || this.buffer.toString('ascii', 8, 12) !== 'WAVE') return out;
        }

        let offset = 12;
        while (true) {
            if (this.buffer.length < offset + 8) return out;
            const id = this.buffer.toString('ascii', offset, offset + 4);
            const size = this.buffer.readUInt32LE(offset + 4);
            const chunkDataStart = offset + 8;
            const paddedSize = size + (size % 2);

            if (id === 'data') {
                if (this.buffer.length < chunkDataStart) return out;
                this.inData = true;
                // Some streaming WAV writers may use 0xffffffff/0 for unknown size; treat as unbounded.
                this.bytesRemaining = (size === 0 || size === 0xffffffff) ? undefined : size;
                const data = this.buffer.subarray(chunkDataStart);
                this.buffer = Buffer.alloc(0);
                if (data.length) out.push(data);
                return out;
            }

            // Need the full chunk to skip it.
            if (this.buffer.length < chunkDataStart + paddedSize) return out;
            offset = chunkDataStart + paddedSize;
        }
    }
}

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

        // TODO: restore
        // await api.setSiren(this.camera.getRtspChannel(), on);
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

        // TODO: restore
        // await api.setWhiteLedState(this.camera.getRtspChannel(), on, brightness);
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

        // TODO: restore
        // await api.setPirInfo(this.camera.getRtspChannel(), { enable: on ? 1 : 0 });
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
    private abilities: any;
    private lastB64Snapshot: string | undefined;
    private lastSnapshotTaken: number | undefined;
    private streamManager: StreamManager;

    private intercomSession: Awaited<ReturnType<ReolinkBaichuanApi['createTalkSession']>> | undefined;
    private intercomFfmpeg: ChildProcessWithoutNullStreams | undefined;
    private intercomWav: WavDataExtractor | undefined;
    private intercomSendChain: Promise<void> = Promise.resolve();
    private intercomStopping: Promise<void> | undefined;

    storageSettings = new StorageSettings(this, {
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
        deviceInfo: {
            json: true,
            hide: true
        },
        abilities: {
            json: true,
            hide: true
        },
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
    });

    constructor(nativeId: string, public plugin: ReolinkNativePlugin) {
        super(nativeId);

        this.streamManager = new StreamManager({
            ensureClient: () => this.ensureClient(),
            getLogger: () => this.getLogger(),
        });

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
            this.baichuanApi = undefined;
            this.baichuanInitPromise = undefined;
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

        // Initialize Baichuan API
        await this.ensureClient();

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
            this.baichuanApi = new ReolinkBaichuanApi({
                host: ipAddress,
                username,
                password,
                logger: this.console,
                // debug: true,
                debugOptions: {
                    // debugRtsp: true,
                    // traceStream: true,
                },
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

    getAbilities() {
        if (!this.abilities) {
            // this.abilities = 
        }

        return this.abilities;
    }

    getEncoderSettings() {
        return this.getDeviceData()?.enc?.Enc;
    }

    async getDetectionInput(detectionId: string, eventId?: any): Promise<MediaObject> {
        return;
    }

    async ptzCommand(command: PanTiltZoomCommand): Promise<void> {
        const client = await this.ensureClient();
        if (!client) {
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
            // Zoom is handled separately
            if (command.zoom !== 0) {
                // TODO: restore
                // await client.zoomToFactor(channel, command.zoom);
            }
            return;
        }

        const ptzCmd: PtzCommand = {
            action: ptzAction,
            command: ptzCommand,
            speed: typeof command.speed === 'number' ? command.speed : 32,
        };

        // TODO: restore
        // await client.ptz(channel, ptzCmd);
    }

    getDeviceData() {
        return this.storageSettings.values.deviceInfo;
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

    async startIntercom(media: MediaObject): Promise<void> {
        const logger = this.getLogger();
        const channel = this.getRtspChannel();

        // Ensure only one intercom session at a time.
        await this.stopIntercom();

        const api = await this.ensureClient();

        const session = await this.withBaichuanRetry(async () => {
            return await api.createTalkSession(channel);
        });
        this.intercomSession = session;

        const { sampleRate, soundTrack } = session.info.audioConfig;
        const fullBlockSize = session.info.fullBlockSize;
        if (!Number.isFinite(fullBlockSize) || fullBlockSize <= 0) {
            await this.stopIntercom();
            throw new Error(`Invalid talk block size: ${fullBlockSize}`);
        }

        const ffmpegInput = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);
        const inputArgs = (ffmpegInput as any)?.inputArguments as string[] | undefined;
        const inputUrl = (ffmpegInput as any)?.url as string | undefined;
        if (!inputUrl) {
            await this.stopIntercom();
            throw new Error('Intercom media did not provide a valid FFmpeg input url');
        }

        // Pipe: input media -> ffmpeg -> WAV(ADPCM IMA) -> strip WAV -> talkSession.sendAudio()
        const ffmpegArgs: string[] = [
            '-hide_banner',
            '-loglevel', 'error',
            ...(Array.isArray(inputArgs) ? inputArgs : []),
            '-i', inputUrl,
            '-vn',
            '-ac', soundTrack?.toLowerCase() === 'stereo' ? '2' : '1',
            '-ar', String(sampleRate),
            '-c:a', 'adpcm_ima_wav',
            // Critical: match the camera's expected ADPCM block size (includes the 4-byte predictor header).
            '-block_size', String(fullBlockSize),
            '-f', 'wav',
            'pipe:1',
        ];

        logger.log(`Starting intercom for channel ${channel}: adpcm_ima_wav ${sampleRate}Hz block=${fullBlockSize}`);

        this.intercomWav = new WavDataExtractor();
        this.intercomSendChain = Promise.resolve();

        const ff = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.intercomFfmpeg = ff;

        let loggedFirst = false;

        ff.stderr.on('data', (d) => {
            const msg = d.toString().trim();
            if (msg) logger.warn(`intercom ffmpeg: ${msg}`);
        });

        ff.stdout.on('data', (chunk: Buffer) => {
            try {
                if (!this.intercomSession) return;
                const parts = this.intercomWav?.push(chunk) ?? [];
                for (const p of parts) {
                    if (!p.length) continue;
                    if (!loggedFirst) {
                        loggedFirst = true;
                        const head = p.subarray(0, Math.min(16, p.length)).toString('hex');
                        logger.log(`Intercom first ADPCM bytes: len=${p.length} head=${head}`);
                    }

                    // Serialize sendAudio calls to avoid races with the session's internal pump.
                    const sendChunk = Buffer.from(p);
                    this.intercomSendChain = this.intercomSendChain
                        .then(async () => {
                            if (!this.intercomSession) return;
                            await this.intercomSession.sendAudio(sendChunk);
                        })
                        .catch((e) => {
                            logger.warn('Intercom sendAudio error', e);
                        });
                }
            }
            catch (e) {
                logger.warn('Intercom pipeline error', e);
            }
        });

        ff.once('exit', (code, signal) => {
            if (code === 0) return;
            logger.warn(`intercom ffmpeg exited: code=${code} signal=${signal}`);
            // Ensure we teardown the intercom session if ffmpeg dies.
            this.stopIntercom().catch(() => { });
        });
    }

    stopIntercom(): Promise<void> {
        if (this.intercomStopping) return this.intercomStopping;

        this.intercomStopping = (async () => {
            const logger = this.getLogger();

            const ff = this.intercomFfmpeg;
            this.intercomFfmpeg = undefined;
            this.intercomWav = undefined;

            if (ff) {
                try {
                    ff.stdout?.removeAllListeners();
                    ff.stderr?.removeAllListeners();
                } catch {
                    // ignore
                }
                try {
                    ff.kill('SIGKILL');
                } catch {
                    // ignore
                }
            }

            const session = this.intercomSession;
            this.intercomSession = undefined;

            // Flush any pending sendAudio and then stop the talk session.
            try {
                await this.intercomSendChain;
            } catch {
                // ignore
            }
            this.intercomSendChain = Promise.resolve();

            if (session) {
                try {
                    await session.stop();
                }
                catch (e) {
                    logger.warn('Intercom session stop error', e);
                }
            }
        })().finally(() => {
            this.intercomStopping = undefined;
        });

        return this.intercomStopping;
    }

    hasSiren() {
        const abilities = this.getAbilities();
        // Check for audio alarm support in abilities
        const hasAbility = abilities?.supportAudioAlarm || abilities?.audioAlarm;
        return hasAbility && (typeof hasAbility === 'number' ? hasAbility > 0 : hasAbility === 1);
    }

    hasFloodlight() {
        const channelData = this.getAbilities();
        // Check for floodlight/white LED support
        const floodLight = channelData?.floodLight || channelData?.whiteLed || channelData?.supportFLswitch || channelData?.supportFLBrightness;
        return floodLight && (typeof floodLight === 'number' ? floodLight > 0 : floodLight === 1);
    }

    hasBattery() {
        const abilities = this.getAbilities();
        const battery = abilities?.battery;
        return battery && (typeof battery === 'number' ? battery > 0 : battery === 1);
    }

    getPtzCapabilities() {
        const abilities = this.getAbilities();
        const hasZoom = abilities?.supportDigitalZoom || abilities?.zoom;
        const hasPanTilt = abilities?.ptzCtrl || abilities?.ptz;
        const hasPresets = abilities?.ptzPreset || abilities?.preset;

        return {
            hasZoom: hasZoom && (typeof hasZoom === 'number' ? hasZoom > 0 : hasZoom === 1),
            hasPanTilt: hasPanTilt && (typeof hasPanTilt === 'number' ? hasPanTilt > 0 : hasPanTilt === 1),
            hasPresets: hasPresets && (typeof hasPresets === 'number' ? hasPresets > 0 : hasPresets === 1),
            hasPtz: (hasZoom || hasPanTilt || hasPresets) &&
                ((typeof hasZoom === 'number' ? hasZoom > 0 : hasZoom === 1) ||
                    (typeof hasPanTilt === 'number' ? hasPanTilt > 0 : hasPanTilt === 1) ||
                    (typeof hasPresets === 'number' ? hasPresets > 0 : hasPresets === 1))
        };
    }

    hasPtzCtrl() {
        const abilities = this.getAbilities();
        const zoom = abilities?.supportDigitalZoom || abilities?.zoom;
        return zoom && (typeof zoom === 'number' ? zoom > 0 : zoom === 1);
    }

    hasPirEvents() {
        const abilities = this.getAbilities();
        const pir = abilities?.mdWithPir || abilities?.pir;
        return pir && (typeof pir === 'number' ? pir > 0 : pir === 1);
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

    updateDeviceInfo() {
        const ip = this.storageSettings.values.ipAddress;
        if (!ip)
            return;
        const info = this.info || {};
        info.ip = ip;

        const deviceData = this.getDeviceData();

        info.serialNumber = deviceData?.serialNumber || deviceData?.itemNo;
        info.firmware = deviceData?.firmwareVersion || deviceData?.firmVer;
        info.version = deviceData?.hardwareVersion || deviceData?.boardInfo;
        info.model = deviceData?.type || deviceData?.typeInfo;
        info.manufacturer = 'Reolink';
        info.managementUrl = `http://${ip}`;
        this.info = info;
    }

    async processEvents(events: { motion?: boolean; objects?: string[] }) {
        const logger = this.getLogger();

        // const debugEvents = this.storageSettings.values.debugEvents;
        // if (debugEvents) {
        //     logger.debug(`Events received: ${JSON.stringify(events)}`);
        // }

        if (events.motion !== this.motionDetected) {
            if (events.motion) {

                this.motionDetected = true;
                this.motionTimeout && clearTimeout(this.motionTimeout);
                this.motionTimeout = setTimeout(() => this.motionDetected = false, this.storageSettings.values.motionTimeout * 1000);
            } else {
                this.motionDetected = false;
                this.motionTimeout && clearTimeout(this.motionTimeout);
            }
        }

        if (events.objects.length) {
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

    async listenLoop() {
        return null;
    }

    async listenEvents() {
        return null;
    }

    async takeSnapshotInternal(timeout?: number) {
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
}