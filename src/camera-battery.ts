import type { ReolinkBaichuanApi, SleepStatus } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, {
    type MediaObject,
    RequestPictureOptions,
    ResponsePictureOptions
} from "@scrypted/sdk";
import {
    CommonCameraMixin,
} from "./common";
import { DebugLogOption } from "./debug-options";
import type ReolinkNativePlugin from "./main";
import { ReolinkNativeNvrDevice } from "./nvr";
import { ReolinkNativeMultiFocalDevice } from "./multiFocal";

export class ReolinkNativeBatteryCamera extends CommonCameraMixin {
    doorbellBinaryTimeout?: NodeJS.Timeout;
    motionDetected: boolean = false;
    motionTimeout: NodeJS.Timeout | undefined;
    private periodicStarted = false;
    private sleepCheckTimer: NodeJS.Timeout | undefined;
    private batteryUpdateTimer: NodeJS.Timeout | undefined;
    private lastBatteryLevel: number | undefined;
    private batteryUpdateInProgress: boolean = false;

    private isBatteryInfoLoggingEnabled(): boolean {
        const debugLogs = this.storageSettings.values.debugLogs || [];
        return debugLogs.includes(DebugLogOption.BatteryInfo);
    }

    constructor(
        nativeId: string, 
        public plugin: ReolinkNativePlugin, 
        nvrDevice?: ReolinkNativeNvrDevice,
        multiFocalDevice?: ReolinkNativeMultiFocalDevice
    ) {
        super(nativeId, plugin, {
            type: 'battery',
            nvrDevice,
            multiFocalDevice,
        });
    }

    async init(): Promise<void> {
        this.startPeriodicTasks();
        await this.alignAuxDevicesState();
        await this.updateBatteryInfo();
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
        const logger = this.getBaichuanLogger();
        this.periodicStarted = true;

        logger.log('Starting periodic tasks for battery camera');

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
                    logger.warn('Error checking sleeping state:', e);
                }
            }, 5_000);
        }

        // Update battery and snapshot every N minutes
        const { batteryUpdateIntervalMinutes = 10 } = this.storageSettings.values;
        const updateIntervalMs = batteryUpdateIntervalMinutes * 60_000;
        this.batteryUpdateTimer = setInterval(() => {
            this.updateBatteryAndSnapshot().catch(() => { });
        }, updateIntervalMs);

        logger.log(`Periodic tasks started: sleep check every 5s, battery update every ${batteryUpdateIntervalMinutes} minutes`);
    }

    async updateSleepingState(sleepStatus: SleepStatus): Promise<void> {
        try {
            if (this.isBatteryInfoLoggingEnabled()) {
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
            this.getBaichuanLogger().debug('Error in checkSleepingState:', e);
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

    async updateBatteryInfo() {
        const api = await this.ensureClient();
        const channel = this.storageSettings.values.rtspChannel;

        const batteryInfo = await api.getBatteryInfo(channel);
        if (this.isBatteryInfoLoggingEnabled()) {
            this.getBaichuanLogger().debug('getBatteryInfo result:', JSON.stringify(batteryInfo));
        }

        if (batteryInfo.batteryPercent !== undefined) {
            const oldLevel = this.lastBatteryLevel;
            this.batteryLevel = batteryInfo.batteryPercent;
            this.lastBatteryLevel = batteryInfo.batteryPercent;

            let shouldCheckRecordingAction = true;

            // Log only if battery level changed
            if (oldLevel !== undefined && oldLevel !== batteryInfo.batteryPercent) {
                if (batteryInfo.chargeStatus !== undefined) {
                    // chargeStatus: "0"=charging, "1"=discharging, "2"=full
                    const charging = batteryInfo.chargeStatus === "0" || batteryInfo.chargeStatus === "2";
                    this.getBaichuanLogger().log(`Battery level changed: ${oldLevel}% → ${batteryInfo.batteryPercent}% (charging: ${charging})`);
                } else {
                    this.getBaichuanLogger().log(`Battery level changed: ${oldLevel}% → ${batteryInfo.batteryPercent}%`);
                }
            } else if (oldLevel === undefined) {
                // First time setting battery level
                if (batteryInfo.chargeStatus !== undefined) {
                    const charging = batteryInfo.chargeStatus === "0" || batteryInfo.chargeStatus === "2";
                    this.getBaichuanLogger().log(`Battery level set: ${batteryInfo.batteryPercent}% (charging: ${charging})`);
                } else {
                    this.getBaichuanLogger().log(`Battery level set: ${batteryInfo.batteryPercent}%`);
                }
            } else {
                shouldCheckRecordingAction = false;
            }

            if (shouldCheckRecordingAction) {
                await this.checkRecordingAction(batteryInfo.batteryPercent);
            }
        }
    }

    private async updateBatteryAndSnapshot(): Promise<void> {
        // Prevent multiple simultaneous calls
        if (this.batteryUpdateInProgress) {
            this.getBaichuanLogger().debug('Battery update already in progress, skipping');
            return;
        }

        this.batteryUpdateInProgress = true;
        try {
            const channel = this.storageSettings.values.rtspChannel;
            const updateIntervalMinutes = this.storageSettings.values.batteryUpdateIntervalMinutes ?? 10;
            this.getBaichuanLogger().log(`Force battery update interval started (every ${updateIntervalMinutes} minutes)`);

            // Ensure we have a client connection
            const api = await this.ensureClient();
            if (!api) {
                this.getBaichuanLogger().warn('Failed to ensure client connection for battery update');
                return;
            }

            // Check current sleep status
            let sleepStatus = api.getSleepStatus({ channel });

            // If camera is sleeping, wake it up
            if (sleepStatus.state === 'sleeping') {
                this.getBaichuanLogger().log('Camera is sleeping, waking up for periodic update...');
                try {
                    await api.wakeUp(channel, { waitAfterWakeMs: 2000 });
                    this.getBaichuanLogger().log('Wake command sent, waiting for camera to wake up...');
                } catch (wakeError) {
                    this.getBaichuanLogger().warn('Failed to wake up camera:', wakeError);
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
                        this.getBaichuanLogger().log('Camera is now awake');
                        this.sleeping = false;
                        break;
                    }
                }

                if (!awake) {
                    this.getBaichuanLogger().warn('Camera did not wake up within timeout, skipping update');
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
                this.getBaichuanLogger().warn('Failed to get battery info during periodic update:', e);
            }

            // 2. Align auxiliary devices state
            try {
                await this.alignAuxDevicesState();
            } catch (e) {
                this.getBaichuanLogger().warn('Failed to align auxiliary devices state:', e);
            }

            // 3. Update snapshot
            try {
                this.forceNewSnapshot = true;
                await this.takePicture();
                this.getBaichuanLogger().log('Snapshot updated during periodic update');
            } catch (snapshotError) {
                this.getBaichuanLogger().warn('Failed to update snapshot during periodic update:', snapshotError);
            }
        } catch (e) {
            this.getBaichuanLogger().warn('Failed to update battery and snapshot', e);
        } finally {
            this.batteryUpdateInProgress = false;
        }
    }

    async resetBaichuanClient(reason?: any): Promise<void> {
        try {
            this.unsubscribedToEvents?.();

            // Close all stream servers before closing the main connection
            // This ensures streams are properly cleaned up when using shared connection
            if (this.streamManager) {
                const reasonStr = reason?.message || reason?.toString?.() || 'connection reset';
                await this.streamManager.closeAllStreams(reasonStr);
            }

            await this.baichuanApi?.close();
        }
        catch (e) {
            this.getBaichuanLogger().warn('Error closing Baichuan client during reset', e);
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
            this.getBaichuanLogger().warn(`Baichuan client reset requested: ${message}`);
        }
    }

    protected async withBaichuanClient<T>(fn: (api: ReolinkBaichuanApi) => Promise<T>): Promise<T> {
        const client = await this.ensureClient();
        return fn(client);
    }

    async createStreamClient(): Promise<ReolinkBaichuanApi> {
        return await this.ensureClient();
    }
}
