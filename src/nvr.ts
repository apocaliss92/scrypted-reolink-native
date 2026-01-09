import type { EventsResponse, ReolinkBaichuanApi, ReolinkBaichuanDeviceSummary, ReolinkSimpleEvent } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { AdoptDevice, Device, DeviceDiscovery, DeviceProvider, DiscoveredDevice, Reboot, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { BaseBaichuanClass, type BaichuanConnectionCallbacks, type BaichuanConnectionConfig } from "./baichuan-base";
import { ReolinkNativeCamera } from "./camera";
import { ReolinkNativeBatteryCamera } from "./camera-battery";
import { normalizeUid } from "./connect";
import { convertDebugLogsToApiOptions, getApiRelevantDebugLogs, getDebugLogChoices } from "./debug-options";
import ReolinkNativePlugin from "./main";
import { getDeviceInterfaces, updateDeviceInfo } from "./utils";

export class ReolinkNativeNvrDevice extends BaseBaichuanClass implements Settings, DeviceDiscovery, DeviceProvider, Reboot {
    storageSettings = new StorageSettings(this, {
        debugLogs: {
            title: 'Debug Events',
            type: 'boolean',
            immediate: true,
        },
        eventSource: {
            title: 'Event Source',
            description: 'Select the source for camera events: Native (Baichuan) or CGI (HTTP polling)',
            type: 'string',
            choices: ['Native', 'CGI'],
            defaultValue: 'Native',
            immediate: true,
            onPut: async () => {
                await this.reinitEventSubscriptions();
            }
        },
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
                            logger.warn('Failed to reset client after debug logs change', e);
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
    lastNvrInfoCheck: number | undefined;
    lastErrorsCheck: number | undefined;
    lastDevicesStatusCheck: number | undefined;
    cameraNativeMap = new Map<string, ReolinkNativeCamera | ReolinkNativeBatteryCamera>();
    private channelToNativeIdMap = new Map<number, string>();
    private discoverDevicesPromise: Promise<DiscoveredDevice[]> | undefined;
    processing = false;
    private initReinitTimeout: NodeJS.Timeout | undefined;
    private debugLogsResetTimeout: NodeJS.Timeout | undefined;

    constructor(nativeId: string, plugin: ReolinkNativePlugin) {
        super(nativeId);
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
            getEventSubscriptionEnabled: () => {
                const eventSource = this.storageSettings.values.eventSource || 'Native';
                return eventSource === 'Native';
            },
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

    private forwardNativeEvent(ev: ReolinkSimpleEvent): void {
        const logger = this.getBaichuanLogger();

        const eventSource = this.storageSettings.values.eventSource || 'Native';
        if (eventSource !== 'Native') {
            return;
        }

        try {
            logger.debug(`Baichuan event: ${JSON.stringify(ev)}`);

            // Find camera for this channel
            const channel = ev?.channel;
            if (channel === undefined) {
                logger.error('Event has no channel, ignoring');
                return;
            }

            const nativeId = this.channelToNativeIdMap.get(channel);
            const targetCamera = nativeId ? this.cameraNativeMap.get(nativeId) : undefined;

            if (!targetCamera) {
                logger.debug(`No camera found for channel ${channel} (nativeId: ${nativeId}), ignoring event`);
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
                        targetCamera.handleDoorbellEvent();
                    }
                    catch (e) {
                        logger.warn(`Error handling doorbell event for camera channel ${channel}`, e);
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
                (targetCamera as ReolinkNativeBatteryCamera).updateSleepingState({
                    reason: 'NVR',
                    state: ev.type === 'sleeping' ? 'sleeping' : 'awake',
                }).catch(() => { });
            } if (isSleepingEvent) {
                (targetCamera as ReolinkNativeBatteryCamera).updateOnlineState(
                    ev.type === 'online' ? true : false
                ).catch(() => { });
            } else {
                // Process events on the target camera
                targetCamera.processEvents({ motion, objects }).catch((e) => {
                    logger.warn(`Error processing events for camera channel ${channel}`, e);
                });
            }
        }
        catch (e) {
            logger.warn('Error in NVR Native event forwarder', e);
        }
    }

    async ensureBaichuanClient(): Promise<ReolinkBaichuanApi> {
        // Use base class implementation
        return await super.ensureBaichuanClient();
    }

    async subscribeToAllEvents(): Promise<void> {
        const eventSource = this.storageSettings.values.eventSource || 'Native';

        if (eventSource !== 'Native') {
            await this.unsubscribeFromAllEvents();
        } else {
            await super.subscribeToEvents();
        }
    }

    private async runNvrDiagnostics(): Promise<void> {
        const logger = this.getBaichuanLogger();
        logger.log(`Starting NVR diagnostics...`);

        try {
            const api = await this.ensureBaichuanClient();

            await api.collectNvrDiagnostics({
                logger: this.console,
            });
        } catch (e) {
            logger.error('Failed to run NVR diagnostics', e);
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
    private async reinitEventSubscriptions(): Promise<void> {
        const logger = this.getBaichuanLogger();
        const { eventSource } = this.storageSettings.values;

        // Unsubscribe from Native events if switching away
        if (eventSource !== 'Native') {
            await this.unsubscribeFromAllEvents();
        } else {
            this.subscribeToAllEvents().catch((e) => {
                logger.warn('Failed to subscribe to Native events', e);
            });
        }

        logger.log(`Event source set to: ${eventSource}`);
    }

    /**
     * Forward events from CGI source to cameras
     */
    private forwardCgiEvents(eventsRes: Record<number, EventsResponse>): void {
        const logger = this.getBaichuanLogger();

        logger.debug(`CGI Events call result: ${JSON.stringify(eventsRes)}`);

        // Use channel map for efficient lookup
        for (const [channel, nativeId] of this.channelToNativeIdMap.entries()) {
            const targetCamera = nativeId ? this.cameraNativeMap.get(nativeId) : undefined;
            const cameraEventsData = eventsRes[channel];
            if (cameraEventsData && targetCamera) {
                targetCamera.processEvents(cameraEventsData);
            }
        }
    }

    async init() {
        const logger = this.getBaichuanLogger();
        await this.ensureBaichuanClient();

        await this.updateDeviceInfo();

        await this.reinitEventSubscriptions();

        setInterval(async () => {
            if (this.processing) {
                return;
            }
            this.processing = true;
            try {
                const now = Date.now();

                if (!this.lastErrorsCheck || (now - this.lastErrorsCheck > 60 * 1000)) {
                    this.lastErrorsCheck = now;
                    // Note: ReolinkCgiApi doesn't have checkErrors, skip for now
                }

                if (!this.lastNvrInfoCheck || now - this.lastNvrInfoCheck > 1000 * 60 * 5) {
                    this.lastNvrInfoCheck = now;
                    // const { nvrData } = await api.getNvrInfo();
                    // const { devicesData, channelsResponse, response } = await api.getDevicesInfo();
                    // logger.log(`NVR info data fetched`);
                    // logger.debug(`${JSON.stringify({ nvrData, devicesData, channelsResponse, response })}`);

                    await this.discoverDevices(true);
                }

                const api = await this.ensureBaichuanClient();

                const { eventSource } = this.storageSettings.values;

                if (eventSource === 'CGI') {
                    const eventsRes = await api.getAllChannelsEvents();
                    this.forwardCgiEvents(eventsRes.parsed);

                    const { batteryInfoData, response } = await api.getAllChannelsBatteryInfo();

                    logger.debug(`Battery info call result: ${JSON.stringify({ batteryInfoData, response })}`);

                    this.cameraNativeMap.forEach((camera) => {
                        if (camera) {
                            const channel = camera.storageSettings.values.rtspChannel;
                            const cameraBatteryData = batteryInfoData[channel];
                            if (cameraBatteryData) {
                                (camera as ReolinkNativeBatteryCamera).updateSleepingState({
                                    reason: 'NVR',
                                    state: cameraBatteryData.sleeping ? 'sleeping' : 'awake',
                                    idleMs: 0,
                                    lastRxAtMs: 0,
                                }).catch(() => { });
                            }
                        }
                    });
                }
            } catch (e) {
                logger.error('Error on events flow', e);
            } finally {
                this.processing = false;
            }
        }, 1000);
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
            logger.warn('Failed to fetch device info', e);
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

    async getDevice(nativeId: string): Promise<ReolinkNativeCamera | ReolinkNativeBatteryCamera> {
        let device = this.cameraNativeMap.get(nativeId);

        if (!device) {
            if (nativeId.endsWith('-battery-cam')) {
                device = new ReolinkNativeBatteryCamera(nativeId, this.plugin, this);
            } else {
                device = new ReolinkNativeCamera(nativeId, this.plugin, this);
            }
            this.cameraNativeMap.set(nativeId, device);
        }

        return device;
    }

    buildNativeId(channel: number, serialNumber?: string, isBattery?: boolean): string {
        const suffix = isBattery ? '-battery-cam' : '-cam';
        if (serialNumber) {
            return `${this.nativeId}-ch${channel}-${serialNumber}${suffix}`;
        }
        return `${this.nativeId}-ch${channel}${suffix}`;
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

        const api = await this.ensureBaichuanClient();
        const { devices, channels } = await api.getDevicesInfo();
        logger.log(devices, channels);

        if (!channels.length) {
            logger.debug(`No channels found, ${JSON.stringify({ channels, devices })}`);
            return;
        }

        logger.log(`Sync entities from remote for ${channels.length} channels`);

        for (const deviceData of devices) {
            const { isBattery, name, model, isDoorbell, uid, channel } = deviceData

            try {
                const nativeId = this.buildNativeId(channel, uid, isBattery);
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
                        serialNumber: uid,
                    }
                };

                this.channelToNativeIdMap.set(channel, nativeId);

                if (sdk.deviceManager.getNativeIds().includes(nativeId)) {
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

        const isBattery = entry.device.interfaces.includes(ScryptedInterface.Battery);
        const { uid } = entry.deviceData;

        const { ReolinkBaichuanApi } = await import("@apocaliss92/reolink-baichuan-js");
        const transport = 'tcp';
        const normalizedUid = isBattery && uid ? normalizeUid(uid) : undefined;
        const baichuanApi = new ReolinkBaichuanApi({
            host: this.storageSettings.values.ipAddress,
            username: this.storageSettings.values.username,
            password: this.storageSettings.values.password,
            transport,
            channel: entry.rtspChannel,
            ...(normalizedUid ? { uid: normalizedUid } : {}),
        });
        await baichuanApi.login();
        const { capabilities, objects, presets } = await baichuanApi.getDeviceCapabilities(entry.rtspChannel);
        const { interfaces, type } = getDeviceInterfaces({
            capabilities,
            logger: this.console,
        });

        const actualDevice: Device = {
            ...entry.device,
            interfaces,
            type
        };

        await sdk.deviceManager.onDeviceDiscovered(actualDevice);

        const device = await this.getDevice(adopt.nativeId);
        const logger = this.getBaichuanLogger();
        logger.log('Adopted device', device?.name);
        logger.log(JSON.stringify(entry));
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

