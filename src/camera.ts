import type { DebugOptions, ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { MediaObject, ObjectsDetected, RequestPictureOptions, ResponsePictureOptions, ScryptedInterface, Setting } from "@scrypted/sdk";
import { UrlMediaStreamOptions } from "../../scrypted/plugins/rtsp/src/rtsp";
import {
    CommonCameraMixin,
} from "./common";
import { createBaichuanApi } from './connect';
import ReolinkNativePlugin from "./main";
import {
    buildVideoStreamOptionsFromRtspRtmp,
    fetchVideoStreamOptionsFromApi
} from './stream-utils';

export const moToB64 = async (mo: MediaObject) => {
    const bufferImage = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
    return bufferImage?.toString('base64');
}

export const b64ToMo = async (b64: string) => {
    const buffer = Buffer.from(b64, 'base64');
    return await sdk.mediaManager.createMediaObject(buffer, 'image/jpeg');
}

export class ReolinkNativeCamera extends CommonCameraMixin {
    videoStreamOptions: Promise<UrlMediaStreamOptions[]>;
    motionTimeout?: NodeJS.Timeout;
    initComplete: boolean = false;
    doorbellBinaryTimeout?: NodeJS.Timeout;
    ptzCapabilities?: any;

    private periodicStarted = false;
    private statusPollTimer: NodeJS.Timeout | undefined;


    constructor(nativeId: string, public plugin: ReolinkNativePlugin) {
        super(nativeId, plugin, {
            protocol: 'tcp',
            includeStreamSource: true,
            onIpAddressPut: async () => {
                // Invalidate cache when IP changes
                this.cachedVideoStreamOptions = undefined;
                this.cachedNetPort = undefined;
            },
            onUsernamePut: async () => {
                // Invalidate cache when username changes
                this.cachedVideoStreamOptions = undefined;
            },
            onPasswordPut: async () => {
                // Invalidate cache when password changes
                this.cachedVideoStreamOptions = undefined;
            },
            onRtspChannelPut: async () => {
                // Invalidate cache when channel changes
                this.cachedVideoStreamOptions = undefined;
            },
            onStreamSourcePut: async () => {
                // Invalidate cache when stream source changes
                this.cachedVideoStreamOptions = undefined;
                this.cachedNetPort = undefined;
            },
        });
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

    async resetBaichuanClient(reason?: any): Promise<void> {
        try {
            this.unsubscribedToEvents?.();
            await (this as any).baichuanApi?.close();
        }
        catch (e) {
            this.getLogger().warn('Error closing Baichuan client during reset', e);
        }
        finally {
            (this as any).baichuanApi = undefined;
            (this as any).connectionTime = undefined;
            (this as any).ensureClientPromise = undefined;
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

            // Reset client and clear cache on recoverable error
            await this.resetBaichuanClient(e);
            this.cachedNetPort = undefined;

            // Important: callers must re-acquire the client inside fn.
            try {
                return await fn();
            } catch (retryError) {
                // If retry also fails with recoverable error, don't spam logs
                if (this.isRecoverableBaichuanError(retryError)) {
                    // Silently fail to avoid spam, but still throw to caller
                    throw retryError;
                }
                throw retryError;
            }
        }
    }

    public getLogger() {
        return this.console;
    }

    async init() {
        this.startPeriodicTasks();
        await this.refreshAuxDevicesStatus();
    }

    getBaichuanDebugOptions(): any | undefined {
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

    async createStreamClient(): Promise<ReolinkBaichuanApi> {
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
        return (this as any).baichuanApi;
    }

    private passiveRefreshTimer: ReturnType<typeof setTimeout> | undefined;

    async release() {
        this.statusPollTimer && clearInterval(this.statusPollTimer);
        if (this.passiveRefreshTimer) {
            clearTimeout(this.passiveRefreshTimer);
            this.passiveRefreshTimer = undefined;
        }
        return this.resetBaichuanClient();
    }

    startPeriodicTasks(): void {
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

    async refreshAuxDevicesStatus(): Promise<void> {
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

    async getDetectionInput(detectionId: string, eventId?: any): Promise<MediaObject> {
        return null;
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

    async takePicture(options?: RequestPictureOptions) {
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



    async getVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        // During init, return empty array to avoid connection issues
        if (!this.initComplete) {
            return [];
        }

        // Return cached options if available
        if (this.cachedVideoStreamOptions) {
            return this.cachedVideoStreamOptions;
        }

        return this.withBaichuanRetry(async () => {
            const streamSource = this.storageSettings.values.streamSource || 'Default';

            const client = await this.ensureClient();

            // If setting is "Native", keep current behavior
            if (streamSource === 'Native') {
                const channel = this.storageSettings.values.rtspChannel;
                const streams = await fetchVideoStreamOptionsFromApi(client, channel, this.console);
                this.cachedVideoStreamOptions = streams;
                return streams;
            }

            // If "Default", check if RTSP/RTMP are available
            const channel = this.storageSettings.values.rtspChannel;
            const { ipAddress, username, password } = this.storageSettings.values;

            if (!ipAddress || !username || !password) {
                // Fallback to Native behavior if credentials are missing
                const streams = await fetchVideoStreamOptionsFromApi(client, channel, this.console);
                this.cachedVideoStreamOptions = streams;
                return streams;
            }

            // Ensure net port cache is populated (with error handling)
            try {
                await this.ensureNetPortCache();
            } catch (e) {
                // If we can't get net port, fallback to Native
                if (!this.isRecoverableBaichuanError(e)) {
                    this.getLogger().warn('Failed to ensure net port cache, falling back to Native', e);
                }
                const streams = await fetchVideoStreamOptionsFromApi(client, channel, this.console);
                this.cachedVideoStreamOptions = streams;
                return streams;
            }

            // Try to build RTSP/RTMP streams
            try {
                const streams = await buildVideoStreamOptionsFromRtspRtmp(
                    client,
                    channel,
                    ipAddress,
                    username,
                    password,
                    this.cachedNetPort,
                );

                // If we found RTSP/RTMP streams, use them
                if (streams.length > 0) {
                    this.cachedVideoStreamOptions = streams;
                    return streams;
                }
            } catch (e) {
                // Only log if it's not a recoverable error to avoid spam
                if (!this.isRecoverableBaichuanError(e)) {
                    this.getLogger().warn('Failed to build RTSP/RTMP stream options, falling back to Native', e);
                }
                // Clear cache on error to force retry on next call
                this.cachedNetPort = undefined;
            }

            // Fallback to Native behavior if RTSP/RTMP are not available
            const streams = await fetchVideoStreamOptionsFromApi(client, channel, this.console);
            this.cachedVideoStreamOptions = streams;
            return streams;
        });
    }

    async getOtherSettings(): Promise<Setting[]> {
        return await this.getSettings();
    }

    showRtspUrlOverride() {
        return false;
    }


    async startIntercom(media: MediaObject): Promise<void> {
        await this.intercom.start(media);
    }

    stopIntercom(): Promise<void> {
        return this.intercom.stop();
    }
}