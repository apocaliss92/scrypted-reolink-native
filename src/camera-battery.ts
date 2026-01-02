import type { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, {
    type MediaObject,
    RequestPictureOptions,
    ResponsePictureOptions
} from "@scrypted/sdk";
import {
    CommonCameraMixin,
} from "./common";
import { createBaichuanApi, normalizeUid } from "./connect";
import type ReolinkNativePlugin from "./main";

export class ReolinkNativeBatteryCamera extends CommonCameraMixin {
    private lastPicture: { mo: MediaObject; atMs: number } | undefined;
    private takePictureInFlight: Promise<MediaObject> | undefined;
    doorbellBinaryTimeout?: NodeJS.Timeout;
    motionDetected: boolean = false;
    motionTimeout: NodeJS.Timeout | undefined;
    private periodicStarted = false;
    private sleepCheckTimer: NodeJS.Timeout | undefined;
    private batteryUpdateTimer: NodeJS.Timeout | undefined;
    private lastBatteryLevel: number | undefined;
    private forceNewSnapshot: boolean = false;

    private isBatteryInfoLoggingEnabled(): boolean {
        const debugLogs = this.storageSettings.values.debugLogs || [];
        return debugLogs.includes('batteryInfo');
    }

    constructor(nativeId: string, public plugin: ReolinkNativePlugin) {
        super(nativeId, plugin, {
            type: 'battery',
        });
    }

    async takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        const { snapshotCacheMinutes = 5 } = this.storageSettings.values;
        const cacheMs = snapshotCacheMinutes * 60_000;
        if (!this.forceNewSnapshot && cacheMs > 0 && this.lastPicture && Date.now() - this.lastPicture.atMs < cacheMs) {
            this.console.log(`Returning cached snapshot, taken at ${new Date(this.lastPicture.atMs).toLocaleString()}`);
            return this.lastPicture.mo;
        }

        if (this.takePictureInFlight) {
            return await this.takePictureInFlight;
        }

        this.console.log(`Taking new snapshot from camera (forceNewSnapshot: ${this.forceNewSnapshot})`);
        this.forceNewSnapshot = false;

        this.takePictureInFlight = (async () => {
            const channel = this.getRtspChannel();
            const snapshotBuffer = await this.withBaichuanClient(async (api) => {
                return await api.getSnapshot(channel);
            });
            const mo = await sdk.mediaManager.createMediaObject(snapshotBuffer, 'image/jpeg');
            this.lastPicture = { mo, atMs: Date.now() };
            this.console.log(`Snapshot taken at ${new Date(this.lastPicture.atMs).toLocaleString()}`);
            return mo;
        })();

        try {
            return await this.takePictureInFlight;
        }
        finally {
            this.takePictureInFlight = undefined;
        }
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [];
    }

    async init(): Promise<void> {
        this.startPeriodicTasks();
        await this.alignAuxDevicesState();
    }

    async release(): Promise<void> {
        this.stopPeriodicTasks();
        return this.resetBaichuanClient();
    }

    private stopPeriodicTasks(): void {
        if (this.sleepCheckTimer) {
            clearInterval(this.sleepCheckTimer);
            this.sleepCheckTimer = undefined;
        }
        if (this.batteryUpdateTimer) {
            clearInterval(this.batteryUpdateTimer);
            this.batteryUpdateTimer = undefined;
        }
        this.periodicStarted = false;
    }

    private startPeriodicTasks(): void {
        if (this.periodicStarted) return;
        this.periodicStarted = true;

        this.console.log('Starting periodic tasks for battery camera');

        // Check sleeping state every 5 seconds (non-blocking)
        this.sleepCheckTimer = setInterval(() => {
            this.checkSleepingState().catch(() => { });
        }, 5_000);

        // Update battery and snapshot every N minutes
        const { batteryUpdateIntervalMinutes = 10 } = this.storageSettings.values;
        const updateIntervalMs = batteryUpdateIntervalMinutes * 60_000;
        this.batteryUpdateTimer = setInterval(() => {
            this.updateBatteryAndSnapshot().catch(() => { });
        }, updateIntervalMs);

        this.console.log(`Periodic tasks started: sleep check every 5s, battery update every ${batteryUpdateIntervalMinutes} minutes`);
    }

    private async checkSleepingState(): Promise<void> {
        try {
            // IMPORTANT: do not call ensureClient() here.
            // If the camera is asleep or disconnected, ensureClient() may reconnect/login and wake it.
            const api = this.baichuanApi;
            const channel = this.getRtspChannel();

            // If there is no existing client, assume sleeping/idle.
            if (!api) {
                if (!this.sleeping) {
                    this.console.log('Camera is sleeping: no active Baichuan client');
                    this.sleeping = true;
                }
                return;
            }

            // Passive sleep detection (no request sent to camera)
            const sleepStatus = api.getSleepStatus({ channel });
            if (this.isBatteryInfoLoggingEnabled()) {
                this.console.log('getSleepStatus result:', JSON.stringify(sleepStatus));
            }

            if (sleepStatus.state === 'sleeping') {
                // Camera is sleeping
                if (!this.sleeping) {
                    this.console.log(`Camera is sleeping: ${sleepStatus.reason}`);
                    this.sleeping = true;
                }
            } else if (sleepStatus.state === 'awake') {
                // Camera is awake
                const wasSleeping = this.sleeping;
                if (wasSleeping) {
                    this.console.log(`Camera woke up: ${sleepStatus.reason}`);
                    this.sleeping = false;
                }

                // Try to get battery info only when camera is awake.
                // NOTE: getBatteryInfo in UDP mode is best-effort and should not force reconnect/login.
                try {
                    const batteryInfo = await api.getBatteryInfo(channel);
                    if (this.isBatteryInfoLoggingEnabled()) {
                        this.console.log('getBatteryInfo result:', JSON.stringify(batteryInfo));
                    }

                    // Update battery percentage and charge status
                    if (batteryInfo.batteryPercent !== undefined) {
                        const oldLevel = this.lastBatteryLevel;
                        this.batteryLevel = batteryInfo.batteryPercent;
                        this.lastBatteryLevel = batteryInfo.batteryPercent;

                        // Log only if battery level changed
                        if (oldLevel !== undefined && oldLevel !== batteryInfo.batteryPercent) {
                            if (batteryInfo.chargeStatus !== undefined) {
                                // chargeStatus: "0"=charging, "1"=discharging, "2"=full
                                const charging = batteryInfo.chargeStatus === "0" || batteryInfo.chargeStatus === "2";
                                this.console.log(`Battery level changed: ${oldLevel}% → ${batteryInfo.batteryPercent}% (charging: ${charging})`);
                            } else {
                                this.console.log(`Battery level changed: ${oldLevel}% → ${batteryInfo.batteryPercent}%`);
                            }
                        }
                    }
                } catch (batteryError) {
                    // Silently ignore battery info errors to avoid spam
                    this.console.debug('Failed to get battery info:', batteryError);
                }

                // When camera wakes up, align auxiliary devices state and force snapshot (once)
                if (wasSleeping) {
                    this.alignAuxDevicesState().catch(() => { });
                    if (this.forceNewSnapshot) {
                        this.takePicture().catch(() => { });
                    }
                }
            } else {
                // Unknown state
                this.console.debug(`Sleep status unknown: ${sleepStatus.reason}`);
            }
        } catch (e) {
            // Silently ignore errors in sleep check to avoid spam
            this.console.debug('Error in checkSleepingState:', e);
        }
    }

    private async updateBatteryAndSnapshot(): Promise<void> {
        try {
            const api = this.baichuanApi;
            const channel = this.getRtspChannel();

            const updateIntervalMinutes = this.storageSettings.values.batteryUpdateIntervalMinutes ?? 10;
            this.console.log(`Force battery update interval started (every ${updateIntervalMinutes} minutes)`);

            // Do NOT wake the camera on a timer.
            // This prevents battery cameras from ever entering sleep.
            // Instead, if the camera is already awake, refresh battery info; snapshot is left on-demand.
            if (!api) {
                return;
            }

            const sleepStatus = api.getSleepStatus({ channel });
            if (sleepStatus.state !== 'awake') {
                return;
            }

            try {
                const batteryInfo = await api.getBatteryInfo(channel);
                if (this.isBatteryInfoLoggingEnabled()) {
                    this.console.log('getBatteryInfo result:', JSON.stringify(batteryInfo));
                }
                if (batteryInfo.batteryPercent !== undefined) {
                    this.batteryLevel = batteryInfo.batteryPercent;
                    this.lastBatteryLevel = batteryInfo.batteryPercent;
                }
            } catch (e) {
                this.console.debug('Failed to get battery info during periodic update:', e);
            }

            // // Wait a bit for the camera to fully wake up
            // await new Promise(resolve => setTimeout(resolve, 2000));

            // // Get battery info
            // const batteryInfo = await api.getBatteryStatus(channel);
            // if (batteryInfo.batteryPercent !== undefined) {
            //     const oldLevel = this.lastBatteryLevel;
            //     this.batteryLevel = batteryInfo.batteryPercent;
            //     this.lastBatteryLevel = batteryInfo.batteryPercent;

            //     // Log only if battery level changed
            //     if (oldLevel !== undefined && oldLevel !== batteryInfo.batteryPercent) {
            //         if (batteryInfo.chargeStatus !== undefined) {
            //             // chargeStatus: "0"=charging, "1"=discharging, "2"=full
            //             const charging = batteryInfo.chargeStatus === "0" || batteryInfo.chargeStatus === "2";
            //             this.console.log(`Battery level changed: ${oldLevel}% → ${batteryInfo.batteryPercent}% (charging: ${charging})`);
            //         } else {
            //             this.console.log(`Battery level changed: ${oldLevel}% → ${batteryInfo.batteryPercent}%`);
            //         }
            //     } else if (oldLevel === undefined) {
            //         // First time setting battery level
            //         if (batteryInfo.chargeStatus !== undefined) {
            //             const charging = batteryInfo.chargeStatus === "0" || batteryInfo.chargeStatus === "2";
            //             this.console.log(`Battery level set: ${batteryInfo.batteryPercent}% (charging: ${charging})`);
            //         } else {
            //             this.console.log(`Battery level set: ${batteryInfo.batteryPercent}%`);
            //         }
            //     }
            // }

            // // Update snapshot
            // try {
            //     const snapshotBuffer = await api.getSnapshot(channel);
            //     const mo = await sdk.mediaManager.createMediaObject(snapshotBuffer, 'image/jpeg');
            //     this.lastPicture = { mo, atMs: Date.now() };
            //     this.console.log('Snapshot updated');
            // } catch (snapshotError) {
            //     this.console.warn('Failed to update snapshot during periodic update', snapshotError);
            // }

            // this.sleeping = false;
        } catch (e) {
            this.console.warn('Failed to update battery and snapshot', e);
        }
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
            if (this.sleepCheckTimer) {
                clearInterval(this.sleepCheckTimer);
                this.sleepCheckTimer = undefined;
            }
            if (this.batteryUpdateTimer) {
                clearInterval(this.batteryUpdateTimer);
                this.batteryUpdateTimer = undefined;
            }
        }

        if (reason) {
            const message = reason?.message || reason?.toString?.() || reason;
            this.getLogger().warn(`Baichuan client reset requested: ${message}`);
        }
    }

    async withBaichuanRetry<T>(fn: () => Promise<T>): Promise<T> {
        return await fn();
    }

    protected async withBaichuanClient<T>(fn: (api: ReolinkBaichuanApi) => Promise<T>): Promise<T> {
        const client = await this.ensureClient();
        return fn(client);
    }

    async createStreamClient(): Promise<ReolinkBaichuanApi> {
        const { ipAddress, username, password, uid } = this.storageSettings.values;
        if (!ipAddress || !username || !password) {
            throw new Error('Missing camera credentials');
        }
        const normalizedUid = normalizeUid(uid);
        if (!normalizedUid) throw new Error("UID is required for battery cameras (BCUDP)");

        const debugOptions = this.getBaichuanDebugOptions();
        const api = await createBaichuanApi(
            {
                host: ipAddress,
                username,
                password,
                uid: normalizedUid,
                logger: this.console,
                ...(debugOptions ? { debugOptions } : {}),
            },
            'udp',
        );
        await api.login();

        return api;
    }
}
