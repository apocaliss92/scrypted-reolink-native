import type { EventsResponse, NativeVideoStreamVariant, ReolinkBaichuanApi, ReolinkBaichuanDeviceSummary, ReolinkSimpleEvent, StreamProfile } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { AdoptDevice, Device, DeviceDiscovery, DeviceProvider, DiscoveredDevice, Reboot, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { BaseBaichuanClass, type BaichuanConnectionCallbacks, type BaichuanConnectionConfig } from "./baichuan-base";
import { ReolinkNativeCamera } from "./camera";
import { ReolinkNativeBatteryCamera } from "./camera-battery";
import { CommonCameraMixin } from "./common";
import { convertDebugLogsToApiOptions, getApiRelevantDebugLogs, getDebugLogChoices } from "./debug-options";
import ReolinkNativePlugin from "./main";
import { ReolinkNativeMultiFocalDevice } from "./multiFocal";
import { batteryCameraSuffix, batteryMultifocalSuffix, cameraSuffix, getDeviceInterfaces, multifocalSuffix, updateDeviceInfo } from "./utils";
import { createBaichuanApi } from "./connect";
import { parseStreamProfileFromId } from "./stream-utils";

export class ReolinkNativeNvrDevice extends BaseBaichuanClass implements Settings, DeviceDiscovery, DeviceProvider, Reboot {
    storageSettings = new StorageSettings(this, {
        debugLogs: {
            title: 'Debug Events',
            type: 'boolean',
            immediate: true,
        },
        // eventSource: {
        //     title: 'Event Source',
        //     description: 'Select the source for camera events: Native (Baichuan) or CGI (HTTP polling)',
        //     type: 'string',
        //     choices: ['Native', 'CGI'],
        //     defaultValue: 'Native',
        //     immediate: true,
        //     onPut: async () => {
        //         await this.reinitEventSubscriptions();
        //     }
        // },
        ipAddress: {
            title: 'IP address',
            type: 'string',
            onPut: async () => await this.reinit()
        },
        username: {
            title: 'Username',
            placeholder: 'admin',
            defaultValue: 'admin',
            type: 'string',
            onPut: async () => await this.reinit()
        },
        password: {
            title: 'Password',
            type: 'password',
            onPut: async () => await this.reinit()
        },
        diagnosticsRun: {
            subgroup: 'Advanced',
            title: 'Run Diagnostics',
            description: 'Collect NVR diagnostics and display results in logs.',
            type: 'button',
            immediate: true,
            onPut: async () => {
                await this.runNvrDiagnostics();
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
                if (changed) {
                    // Clear any existing timeout
                    if (this.debugLogsResetTimeout) {
                        clearTimeout(this.debugLogsResetTimeout);
                        this.debugLogsResetTimeout = undefined;
                    }

                    // Defer reset by 2 seconds to allow settings to settle
                    this.debugLogsResetTimeout = setTimeout(async () => {
                        this.debugLogsResetTimeout = undefined;
                        try {
                            // Force reconnection with new debug options
                            this.baichuanApi = undefined;
                            this.ensureClientPromise = undefined;
                            // Trigger reconnection
                            await this.ensureBaichuanClient();
                        } catch (e) {
                            logger.warn('Failed to reset client after debug logs change', e?.message || String(e));
                        }
                    }, 2000);
                }
            },
        },
    });
    plugin: ReolinkNativePlugin;
    discoveredDevices = new Map<string, {
        device: Device;
        description: string;
        rtspChannel: number;
        deviceData: ReolinkBaichuanDeviceSummary;
    }>();
    cameraNativeMap = new Map<string, CommonCameraMixin>();
    private channelToNativeIdMap = new Map<number, string>();
    private discoverDevicesPromise: Promise<DiscoveredDevice[]> | undefined;
    processing = false;
    private initReinitTimeout: NodeJS.Timeout | undefined;
    private debugLogsResetTimeout: NodeJS.Timeout | undefined;

    constructor(nativeId: string, plugin: ReolinkNativePlugin) {
        super(nativeId, "tcp");
        this.plugin = plugin;

        this.scheduleInit();
    }

    async reboot(): Promise<void> {
        const api = await this.ensureBaichuanClient();
        await api.reboot();
    }

    protected getConnectionConfig(): BaichuanConnectionConfig {
        const { ipAddress, username, password } = this.storageSettings.values;
        if (!ipAddress || !username || !password) {
            throw new Error('Missing NVR credentials');
        }

        const debugOptions = this.getBaichuanDebugOptions();

        return {
            host: ipAddress,
            username,
            password,
            transport: 'tcp',
            debugOptions,
        };
    }

    protected getStreamClientInputs(): BaichuanConnectionConfig {
        const { ipAddress, username, password } = this.storageSettings.values;
        if (!ipAddress || !username || !password) {
            throw new Error('Missing NVR credentials');
        }

        const debugOptions = this.getBaichuanDebugOptions();

        return {
            host: ipAddress,
            username,
            password,
            transport: 'tcp',
            debugOptions,
        };
    }

    getBaichuanDebugOptions(): any | undefined {
        const socketDebugLogs = this.storageSettings.values.socketApiDebugLogs || [];
        return convertDebugLogsToApiOptions(socketDebugLogs);
    }

    protected getConnectionCallbacks(): BaichuanConnectionCallbacks {
        return {
            onClose: async () => {
                await this.reinit();
            },
            onSimpleEvent: (ev) => this.forwardNativeEvent(ev),
            getEventSubscriptionEnabled: () => true,
            // getEventSubscriptionEnabled: () => {
            //     const eventSource = this.storageSettings.values.eventSource || 'Native';
            //     return eventSource === 'Native';
            // },
        };
    }

    protected isDebugEnabled(): boolean {
        return this.storageSettings.values.debugLogs || false;
    }

    protected getDeviceName(): string {
        return this.name || 'NVR';
    }

    protected async onBeforeCleanup(): Promise<void> {
        await this.unsubscribeFromAllEvents();
    }

    async reinit() {
        if (this.initReinitTimeout) {
            clearTimeout(this.initReinitTimeout);
            this.initReinitTimeout = undefined;
        }

        // Schedule reinit with debounce
        this.scheduleInit(true);
    }

    private scheduleInit(isReinit: boolean = false): void {
        // Cancel any pending init/reinit
        if (this.initReinitTimeout) {
            clearTimeout(this.initReinitTimeout);
        }

        this.initReinitTimeout = setTimeout(async () => {
            if (isReinit) {
                await super.cleanupBaichuanApi();
            }
            await this.init();
            this.initReinitTimeout = undefined;
        }, isReinit ? 500 : 2000);
    }

    /**
     * Forward events received from Baichuan to the appropriate child device (Camera or MultiFocal).
     * This ensures that only NVR (root device) subscribes to events, and events are forwarded down the hierarchy:
     * - NVR → MultiFocal → Camera
     * - NVR → Camera (directly)
     */
    private forwardNativeEvent(ev: ReolinkSimpleEvent): void {
        const logger = this.getBaichuanLogger();

        // const eventSource = this.storageSettings.values.eventSource || 'Native';
        // if (eventSource !== 'Native') {
        //     return;
        // }

        try {
            logger.debug(`Baichuan event: ${JSON.stringify(ev)}`);

            // Find device (camera or multifocal) for this channel
            const channel = ev?.channel;
            if (channel === undefined) {
                logger.error('Event has no channel, ignoring');
                return;
            }

            const nativeId = this.channelToNativeIdMap.get(channel);
            const targetDevice = nativeId ? this.cameraNativeMap.get(nativeId) : undefined;

            if (!targetDevice) {
                logger.debug(`No device found for channel ${channel} (nativeId: ${nativeId}), ignoring event`);
                return;
            }

            // If target is a MultiFocal device, forward the event to it (it will forward to its camera children)
            if (targetDevice instanceof ReolinkNativeMultiFocalDevice) {
                targetDevice.forwardNativeEvent(ev);
                return;
            }

            // Convert event to camera's processEvents format
            const objects: string[] = [];
            let motion = false;
            let isSleepingEvent = false;
            let isOnlineEvent = false;

            switch (ev?.type) {
                case 'motion':
                    motion = true;
                    break;
                case 'doorbell':
                    // Handle doorbell if camera supports it
                    try {
                        targetDevice.handleDoorbellEvent();
                    }
                    catch (e) {
                        logger.warn(`Error handling doorbell event for camera channel ${channel}`, e?.message || String(e));
                    }
                    motion = true;
                    break;
                case 'people':
                case 'vehicle':
                case 'animal':
                case 'face':
                case 'package':
                case 'other':
                    objects.push(ev.type);
                    motion = true;
                    break;
                case 'awake':
                case 'sleeping':
                    isSleepingEvent = true;
                    break;
                case 'offline':
                case 'online':
                    isOnlineEvent = true;
                    break;
                default:
                    logger.error(`Unknown event type: ${ev?.type}`);
                    return;
            }

            if (isSleepingEvent) {
                targetDevice.updateSleepingState({
                    reason: 'NVR',
                    state: ev.type === 'sleeping' ? 'sleeping' : 'awake',
                }).catch(() => { });
            } else if (isOnlineEvent) {
                (targetDevice as ReolinkNativeBatteryCamera).updateOnlineState(
                    ev.type === 'online' ? true : false
                ).catch(() => { });
            } else {
                // Process events on the target camera
                targetDevice.processEvents({ motion, objects }).catch((e) => {
                    logger.warn(`Error processing events for camera channel ${channel}`, e?.message || String(e));
                });
            }
        }
        catch (e) {
            logger.warn('Error in NVR Native event forwarder', e?.message || String(e));
        }
    }

    async ensureBaichuanClient(): Promise<ReolinkBaichuanApi> {
        return await super.ensureBaichuanClient();
    }

    async ensureClient(): Promise<ReolinkBaichuanApi> {
        return await this.ensureBaichuanClient();
    }

    // async subscribeToAllEvents(): Promise<void> {
    // const eventSource = this.storageSettings.values.eventSource || 'Native';

    // if (eventSource !== 'Native') {
    // await this.unsubscribeFromAllEvents();
    // } else {
    // await super.subscribeToEvents();
    // }
    // }

    private async runNvrDiagnostics(): Promise<void> {
        const logger = this.getBaichuanLogger();
        logger.log(`Starting NVR diagnostics...`);

        try {
            const api = await this.ensureBaichuanClient();

            await api.collectNvrDiagnostics({
                logger: this.console,
            });
        } catch (e) {
            logger.error('Failed to run NVR diagnostics', e?.message || String(e));
            throw e;
        }
    }

    async unsubscribeFromAllEvents(): Promise<void> {
        // Use base class implementation
        await super.unsubscribeFromEvents();
    }

    /**
     * Reinitialize event subscriptions based on selected event source
     */
    // private async reinitEventSubscriptions(): Promise<void> {
    //     const logger = this.getBaichuanLogger();
    // const { eventSource } = this.storageSettings.values;

    // // Unsubscribe from Native events if switching away
    // if (eventSource !== 'Native') {
    //     await this.unsubscribeFromAllEvents();
    // } else {
    // this.subscribeToAllEvents().catch((e) => {
    //     logger.warn('Failed to subscribe to Native events', e?.message || String(e));
    // });
    // }

    // logger.log(`Event source set to: ${eventSource}`);
    // }

    /**
     * Forward events from CGI source to cameras
     */
    // private forwardCgiEvents(eventsRes: Record<number, EventsResponse>): void {
    //     const logger = this.getBaichuanLogger();

    //     logger.debug(`CGI Events call result: ${JSON.stringify(eventsRes)}`);

    //     // Use channel map for efficient lookup
    //     for (const [channel, nativeId] of this.channelToNativeIdMap.entries()) {
    //         const targetCamera = nativeId ? this.cameraNativeMap.get(nativeId) : undefined;
    //         const cameraEventsData = eventsRes[channel];
    //         if (cameraEventsData && targetCamera) {
    //             targetCamera.processEvents(cameraEventsData);
    //         }
    //     }
    // }

    async init() {
        // const logger = this.getBaichuanLogger();
        await this.ensureBaichuanClient();

        await this.updateDeviceInfo();
        await this.subscribeToEvents();

        // await this.reinitEventSubscriptions();

        // setInterval(async () => {
        //     if (this.processing) {
        //         return;
        //     }
        //     this.processing = true;
        //     try {
        //         const api = await this.ensureBaichuanClient();

        // const { eventSource } = this.storageSettings.values;

        // if (eventSource === 'CGI') {
        //     const eventsRes = await api.getAllChannelsEvents();
        //     this.forwardCgiEvents(eventsRes.parsed);

        //     const { batteryInfoData, response } = await api.getAllChannelsBatteryInfo();

        //     logger.debug(`Battery info call result: ${JSON.stringify({ batteryInfoData, response })}`);

        //     this.cameraNativeMap.forEach((camera) => {
        //         if (camera) {
        //             const channel = camera.storageSettings.values.rtspChannel;
        //             const cameraBatteryData = batteryInfoData[channel];
        //             if (cameraBatteryData) {
        //                 camera.updateSleepingState({
        //                     reason: 'NVR',
        //                     state: cameraBatteryData.sleeping ? 'sleeping' : 'awake',
        //                     idleMs: 0,
        //                     lastRxAtMs: 0,
        //                 }).catch(() => { });
        //             }
        //         }
        //     });
        // }
        //         } catch (e) {
        //             logger.error('Error on events flow', e?.message || String(e));
        //         } finally {
        //             this.processing = false;
        //         }
        //     }, 1000);
    }

    async updateDeviceInfo(): Promise<void> {
        const logger = this.getBaichuanLogger();

        const { ipAddress } = this.storageSettings.values;
        try {
            const api = await this.ensureBaichuanClient();
            const deviceData = await api.getInfo();

            await updateDeviceInfo({
                device: this,
                ipAddress,
                deviceData,
                logger
            });
        } catch (e) {
            logger.warn('Failed to fetch device info', e?.message || String(e));
        }
    }

    async getSettings(): Promise<Setting[]> {
        const settings = await this.storageSettings.getSettings();
        return settings;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    async releaseDevice(id: string, nativeId: string) {
        this.cameraNativeMap.delete(nativeId);
    }

    async getDevice(nativeId: string): Promise<CommonCameraMixin> {
        let device = this.cameraNativeMap.get(nativeId);

        if (!device) {
            if (nativeId.endsWith(batteryCameraSuffix)) {
                device = new ReolinkNativeBatteryCamera(nativeId, this.plugin, this);
            } else if (nativeId.endsWith(batteryMultifocalSuffix)) {
                device = new ReolinkNativeMultiFocalDevice(nativeId, this.plugin, "multi-focal-battery", this);
            } else if (nativeId.endsWith(multifocalSuffix)) {
                device = new ReolinkNativeMultiFocalDevice(nativeId, this.plugin, "multi-focal", this);
            } else {
                device = new ReolinkNativeCamera(nativeId, this.plugin, this);
            }

            if (device) {
                this.cameraNativeMap.set(nativeId, device);
            }
        }

        return device;
    }

    buildNativeId(props: {
        identifier?: string, isBattery?: boolean, isMultifocal?: boolean
    }): string {
        const { identifier, isBattery, isMultifocal } = props;

        const suffix = isBattery ?
            (isMultifocal ? batteryMultifocalSuffix : batteryCameraSuffix) :
            (isMultifocal ? multifocalSuffix : cameraSuffix)

        return `${this.nativeId}-${identifier}${suffix}`;
    }

    getCameraInterfaces() {
        return [
            ScryptedInterface.VideoCameraConfiguration,
            ScryptedInterface.Camera,
            ScryptedInterface.MotionSensor,
            ScryptedInterface.VideoTextOverlays,
            ScryptedInterface.VideoCamera,
            ScryptedInterface.Settings,
            ScryptedInterface.ObjectDetector,
        ];
    }

    async syncEntitiesFromRemote() {
        const logger = this.getBaichuanLogger();
        // const { ipAddress } = this.storageSettings.values;

        const api = await this.ensureBaichuanClient();
        const { devices, channels } = await api.getNvrChannelsSummary({ source: "cgi" });

        if (!channels.length) {
            logger.debug(`No channels found, ${JSON.stringify({ channels, devices })}`);
            return;
        }

        logger.log(`Sync entities from remote for ${channels.length} channels`);

        for (const deviceData of devices) {
            const { isBattery, serialNumber, name, model, isDoorbell, uid, channel, isMultifocal } = deviceData;
            const identifier = uid || name || `channel-${channel}`;
            // const identifier = uid || mac || (ip !== ipAddress ? ip : undefined) || name || randomBytes(4).toString('hex');

            try {
                const nativeId = this.buildNativeId({
                    isBattery,
                    isMultifocal,
                    identifier,
                });
                const interfaces = [ScryptedInterface.VideoCamera];
                if (isBattery) {
                    interfaces.push(ScryptedInterface.Battery);
                }
                const type = isDoorbell ? ScryptedDeviceType.Doorbell : ScryptedDeviceType.Camera;

                const device: Device = {
                    nativeId,
                    name,
                    providerNativeId: this.nativeId,
                    interfaces,
                    type,
                    info: {
                        manufacturer: 'Reolink',
                        model,
                        serialNumber,
                    }
                };

                this.channelToNativeIdMap.set(channel, nativeId);

                const allNativeIds = sdk.deviceManager.getNativeIds().filter(nid => !!nid);

                if (
                    allNativeIds.some(
                        nid => nid.includes(uid) ||
                            nid.includes(`channel-${channel}`) ||
                            // nid.includes(mac) ||
                            // nid.includes(ip) ||
                            nid.includes(name) ||
                            nid === nativeId)
                ) {
                    continue;
                }

                if (this.discoveredDevices.has(nativeId)) {
                    continue;
                }

                this.discoveredDevices.set(nativeId, {
                    device,
                    description: `${name} (Channel ${channel})`,
                    rtspChannel: channel,
                    deviceData,
                });

                logger.debug(`Discovered channel ${channel}: ${name}`);
            } catch (e: any) {
                logger.debug(`Error processing channel ${channel}: ${e?.message || String(e)}`);
            }
        }

        logger.debug(`Channel discovery completed. ${JSON.stringify({ devices, channels })}`);
    }

    async discoverDevices(scan?: boolean): Promise<DiscoveredDevice[]> {
        // If a discovery is already in progress, return that promise
        if (this.discoverDevicesPromise) {
            return await this.discoverDevicesPromise;
        }

        // If scan is requested, start a new discovery
        if (scan) {
            this.discoverDevicesPromise = (async () => {
                try {
                    await this.syncEntitiesFromRemote();
                    return [...this.discoveredDevices.values()].map(d => ({
                        ...d.device,
                        description: d.description,
                    }));
                } finally {
                    this.discoverDevicesPromise = undefined;
                }
            })();
            return await this.discoverDevicesPromise;
        }

        // If no scan requested, return cached devices immediately
        return [...this.discoveredDevices.values()].map(d => ({
            ...d.device,
            description: d.description,
        }));
    }

    async adoptDevice(adopt: AdoptDevice): Promise<string> {
        const entry = this.discoveredDevices.get(adopt.nativeId);

        if (!entry)
            throw new Error('device not found');

        await this.onDeviceEvent(ScryptedInterface.DeviceDiscovery, await this.discoverDevices());

        const { uid } = entry.deviceData;

        const { ReolinkBaichuanApi } = await import("@apocaliss92/reolink-baichuan-js");
        const transport = 'tcp';
        const baichuanApi = new ReolinkBaichuanApi({
            host: this.storageSettings.values.ipAddress,
            username: this.storageSettings.values.username,
            password: this.storageSettings.values.password,
            transport,
            channel: entry.rtspChannel,
            uid,
        });
        await baichuanApi.login();
        const { capabilities, objects, presets } = await baichuanApi.getDeviceCapabilities(entry.rtspChannel);
        const { interfaces, type } = getDeviceInterfaces({
            capabilities,
            logger: this.getBaichuanLogger(),
        });

        const actualDevice: Device = {
            ...entry.device,
            providerNativeId: this.nativeId,
            interfaces,
            type
        };

        await sdk.deviceManager.onDeviceDiscovered(actualDevice);

        const device = await this.getDevice(adopt.nativeId);
        const logger = this.getBaichuanLogger();
        logger.log('Adopted device', device?.name, JSON.stringify(actualDevice));
        const { username, password, ipAddress } = this.storageSettings.values;

        device.storageSettings.values.rtspChannel = entry.rtspChannel;
        device.classes = objects;
        device.presets = presets;
        device.storageSettings.values.username = username;
        device.storageSettings.values.password = password;
        device.storageSettings.values.rtspChannel = entry.rtspChannel;
        device.storageSettings.values.ipAddress = ipAddress;
        device.storageSettings.values.capabilities = capabilities;
        device.storageSettings.values.uid = uid;

        this.discoveredDevices.delete(adopt.nativeId);
        return device?.id;
    }
}

