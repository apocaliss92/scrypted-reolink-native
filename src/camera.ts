import type { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { MediaObject, ObjectsDetected, RequestPictureOptions, ResponsePictureOptions, ScryptedInterface, Setting } from "@scrypted/sdk";
import { UrlMediaStreamOptions } from "../../scrypted/plugins/rtsp/src/rtsp";
import {
    CommonCameraMixin,
} from "./common";
import { createBaichuanApi } from './connect';
import ReolinkNativePlugin from "./main";
import { ReolinkNativeNvrDevice } from "./nvr";
import { ReolinkNativeMultiFocalDevice } from "./multiFocal";

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
    doorbellBinaryTimeout?: NodeJS.Timeout;
    ptzCapabilities?: any;

    private periodicStarted = false;
    private statusPollTimer: NodeJS.Timeout | undefined;


    constructor(
        nativeId: string,
        public plugin: ReolinkNativePlugin,
        nvrDevice?: ReolinkNativeNvrDevice,
        multiFocalDevice?: ReolinkNativeMultiFocalDevice
    ) {
        super(nativeId, plugin, {
            type: 'regular',
            nvrDevice,
            multiFocalDevice,
        });
    }

    async reportDevices(): Promise<void> {
        // Do nothing
    }

    async resetBaichuanClient(reason?: any): Promise<void> {
        try {
            this.unsubscribedToEvents?.();
            await this.baichuanApi?.close();
        }
        catch (e) {
            this.getBaichuanLogger().warn('Error closing Baichuan client during reset', e?.message || String(e));
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
            this.getBaichuanLogger().warn(`Baichuan client reset requested: ${message}`);
        }
    }


    async init() {
        this.startPeriodicTasks();
        await this.alignAuxDevicesState();
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

        this.getBaichuanLogger().log('Starting periodic tasks for regular camera');

        this.statusPollTimer = setInterval(() => {
            this.periodic10sTick().catch(() => { });
        }, 10_000);

        this.getBaichuanLogger().log('Periodic tasks started: status poll every 10s');
    }

    private async periodic10sTick(): Promise<void> {
        await this.ensureClient();
        await this.alignAuxDevicesState();
    }

    async processEvents(events: { motion?: boolean; objects?: string[] }) {
        const logger = this.getBaichuanLogger();

        if (!this.isEventDispatchEnabled()) return;

        if (this.isDebugEnabled()) {
            logger.debug(`Events received: ${JSON.stringify(events)}`);
        }

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
}