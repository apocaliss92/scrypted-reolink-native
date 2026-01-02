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
            type: 'regular',
        });
    }

    async resetBaichuanClient(reason?: any): Promise<void> {
        try {
            this.unsubscribedToEvents?.();
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
        // Align auxiliary devices state on init
        await this.alignAuxDevicesState();
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
        return this.baichuanApi;
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

        this.console.log('Starting periodic tasks for regular camera');

        this.statusPollTimer = setInterval(() => {
            this.periodic10sTick().catch(() => { });
        }, 10_000);
        
        this.console.log('Periodic tasks started: status poll every 10s');
    }

    private async periodic10sTick(): Promise<void> {
        await this.ensureClient();
        await this.alignAuxDevicesState();
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

    protected async withBaichuanClient<T>(fn: (api: ReolinkBaichuanApi) => Promise<T>): Promise<T> {
        const client = await this.ensureClient();
        return fn(client);
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