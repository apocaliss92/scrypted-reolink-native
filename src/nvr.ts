import type { DeviceInfoResponse, DeviceInputData, EventsResponse, ReolinkBaichuanApi, ReolinkCgiApi, ReolinkSimpleEvent } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { AdoptDevice, Device, DeviceDiscovery, DeviceProvider, DiscoveredDevice, Reboot, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { BaseBaichuanClass, type BaichuanConnectionConfig, type BaichuanConnectionCallbacks } from "./baichuan-base";
import { ReolinkNativeCamera } from "./camera";
import { ReolinkNativeBatteryCamera } from "./camera-battery";
import { normalizeUid } from "./connect";
import ReolinkNativePlugin from "./main";
import { getDeviceInterfaces, updateDeviceInfo } from "./utils";

export class ReolinkNativeNvrDevice extends BaseBaichuanClass implements Settings, DeviceDiscovery, DeviceProvider, Reboot {
    storageSettings = new StorageSettings(this, {
        debugEvents: {
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
    });
    plugin: ReolinkNativePlugin;
    nvrApi: ReolinkCgiApi | undefined;
    // baichuanApi, ensureClientPromise, connectionTime inherited from BaseBaichuanClass
    discoveredDevices = new Map<string, {
        device: Device;
        description: string;
        rtspChannel: number;
        deviceData: DeviceInfoResponse;
    }>();
    lastHubInfoCheck: number | undefined;
    lastErrorsCheck: number | undefined;
    lastDevicesStatusCheck: number | undefined;
    cameraNativeMap = new Map<string, ReolinkNativeCamera | ReolinkNativeBatteryCamera>();
    private channelToNativeIdMap = new Map<number, string>();
    processing = false;

    constructor(nativeId: string, plugin: ReolinkNativePlugin) {
        super(nativeId);
        this.plugin = plugin;

        setTimeout(async () => {
            await this.init();
        }, 5000);
    }

    async reboot(): Promise<void> {
        const api = await this.ensureClient();
        await api.Reboot();
    }

    // BaseBaichuanClass abstract methods implementation
    protected getConnectionConfig(): BaichuanConnectionConfig {
        const { ipAddress, username, password } = this.storageSettings.values;
        if (!ipAddress || !username || !password) {
            throw new Error('Missing NVR credentials');
        }

        return {
            host: ipAddress,
            username,
            password,
            transport: 'tcp',
            logger: this.console,
        };
    }

    protected getConnectionCallbacks(): BaichuanConnectionCallbacks {
        return {
            onError: undefined, // Use default error handling
            onClose: async () => {
                // Reinit after cleanup
                await this.reinit();
            },
            onSimpleEvent: this.onSimpleEventHandler,
            getEventSubscriptionEnabled: () => {
                const eventSource = this.storageSettings.values.eventSource || 'Native';
                return eventSource === 'Native';
            },
        };
    }

    public getLogger(): Console {
        return this.console;
    }

    protected async onBeforeCleanup(): Promise<void> {
        // Unsubscribe from events if needed
        await this.unsubscribeFromAllEvents();
    }

    async reinit() {
        // Cleanup CGI API
        if (this.nvrApi) {
            try {
                await this.nvrApi.logout();
            } catch {
                // ignore
            }
        }
        this.nvrApi = undefined;

        // Cleanup Baichuan API (this handles all listeners and connection)
        await super.cleanupBaichuanApi();
    }

    async ensureClient(): Promise<ReolinkCgiApi> {
        if (this.nvrApi) {
            return this.nvrApi;
        }

        const { ipAddress, username, password } = this.storageSettings.values;
        if (!ipAddress || !username || !password) {
            throw new Error('Missing NVR credentials');
        }

        const { ReolinkCgiApi } = await import("@apocaliss92/reolink-baichuan-js");
        this.nvrApi = new ReolinkCgiApi({
            host: ipAddress,
            username,
            password,
        });

        await this.nvrApi.login();
        return this.nvrApi;
    }

    private forwardNativeEvent(ev: ReolinkSimpleEvent): void {
        const logger = this.getLogger();

        const eventSource = this.storageSettings.values.eventSource || 'Native';
        if (eventSource !== 'Native') {
            return;
        }

        try {
            if (this.storageSettings.values.debugEvents) {
                logger.log(`NVR Baichuan event: ${JSON.stringify(ev)}`);
            }

            // Find camera for this channel
            const channel = ev?.channel;
            if (channel === undefined) {
                if (this.storageSettings.values.debugEvents) {
                    logger.debug('Event has no channel, ignoring');
                }
                return;
            }

            const nativeId = this.channelToNativeIdMap.get(channel);
            const targetCamera = nativeId ? this.cameraNativeMap.get(nativeId) : undefined;

            if (!targetCamera) {
                if (this.storageSettings.values.debugEvents) {
                    logger.debug(`No camera found for channel ${channel}, ignoring event`);
                }
                return;
            }

            // Convert event to camera's processEvents format
            const objects: string[] = [];
            let motion = false;

            switch (ev?.type) {
                case 'motion':
                    motion = true;
                    break;
                case 'doorbell':
                    // Handle doorbell if camera supports it
                    try {
                        if (typeof (targetCamera as any).handleDoorbellEvent === 'function') {
                            (targetCamera as any).handleDoorbellEvent();
                        }
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
                default:
                    if (this.storageSettings.values.debugEvents) {
                        logger.debug(`Unknown event type: ${ev?.type}`);
                    }
                    return;
            }

            // Process events on the target camera
            targetCamera.processEvents({ motion, objects }).catch((e) => {
                logger.warn(`Error processing events for camera channel ${channel}`, e);
            });
        }
        catch (e) {
            logger.warn('Error in NVR Native event forwarder', e);
        }
    }

    async onSimpleEventHandler(ev: ReolinkSimpleEvent) {
        this.forwardNativeEvent(ev);
    }

    async ensureBaichuanClient(): Promise<ReolinkBaichuanApi> {
        // Use base class implementation
        return await super.ensureBaichuanClient();
    }

    async subscribeToAllEvents(): Promise<void> {
        const logger = this.getLogger();
        const eventSource = this.storageSettings.values.eventSource || 'Native';

        // Only subscribe if Native is selected
        if (eventSource !== 'Native') {
            await this.unsubscribeFromAllEvents();
            return;
        }

        // Use base class implementation
        await super.subscribeToEvents();
        logger.log('Subscribed to all events for NVR cameras');
    }

    async unsubscribeFromAllEvents(): Promise<void> {
        // Use base class implementation
        await super.unsubscribeFromEvents();
    }

    /**
     * Reinitialize event subscriptions based on selected event source
     */
    private async reinitEventSubscriptions(): Promise<void> {
        const logger = this.getLogger();
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
        const logger = this.getLogger();

        if (this.storageSettings.values.debugEvents) {
            logger.debug(`CGI Events call result: ${JSON.stringify(eventsRes)}`);
        }

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
        const api = await this.ensureClient();
        const logger = this.getLogger();
        await this.updateDeviceInfo();

        // Initialize event subscriptions based on selected source
        await this.reinitEventSubscriptions();

        setInterval(async () => {
            if (this.processing || !api) {
                return;
            }
            this.processing = true;
            try {
                const now = Date.now();

                if (!this.lastErrorsCheck || (now - this.lastErrorsCheck > 60 * 1000)) {
                    this.lastErrorsCheck = now;
                    // Note: ReolinkCgiApi doesn't have checkErrors, skip for now
                }

                if (!this.lastHubInfoCheck || now - this.lastHubInfoCheck > 1000 * 60 * 5) {
                    logger.log('Starting Hub info data fetch');
                    this.lastHubInfoCheck = now;
                    const { hubData } = await api.getHubInfo();
                    const { devicesData, channelsResponse, response } = await api.getDevicesInfo();
                    logger.log('Hub info data fetched');
                    if (this.storageSettings.values.debugEvents) {
                        logger.log(`${JSON.stringify({ hubData, devicesData, channelsResponse, response })}`);
                    }

                    await this.discoverDevices(true);
                }

                // Only fetch and forward CGI events if CGI is selected as event source
                const { eventSource } = this.storageSettings.values;
                if (eventSource === 'CGI') {
                    const eventsRes = await api.getAllChannelsEvents();
                    this.forwardCgiEvents(eventsRes.parsed);
                }

                // Always fetch battery info (not event-related)
                const { batteryInfoData, response } = await api.getAllChannelsBatteryInfo();

                if (this.storageSettings.values.debugEvents) {
                    logger.debug(`Battery info call result: ${JSON.stringify({ batteryInfoData, response })}`);
                }

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
            } catch (e) {
                this.console.error('Error on events flow', e);
            } finally {
                this.processing = false;
            }
        }, 1000);
    }

    async updateDeviceInfo(): Promise<void> {
        const { ipAddress } = this.storageSettings.values;
        try {
            const api = await this.ensureClient();
            const deviceData = await api.getInfo();

            await updateDeviceInfo({
                device: this,
                ipAddress,
                deviceData,
            });
        } catch (e) {
            this.getLogger().warn('Failed to fetch device info', e);
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
        const api = await this.ensureClient();
        const logger = this.getLogger();

        logger.log('Starting channels discovery using getDevicesInfo...');

        const { devicesData, channels } = await api.getDevicesInfo();

        logger.log(`getDevicesInfo completed. Found ${channels.length} channels.`);

        // Process each channel that was successfully discovered
        for (const channel of channels) {
            try {
                const { channelStatus, channelInfo, abilities } = devicesData[channel];
                const name = channelStatus?.name;
                const uid = channelStatus?.uid;
                const isBattery = !!(abilities?.battery?.ver ?? 0);

                const nativeId = this.buildNativeId(channel, uid, isBattery);
                const interfaces = [ScryptedInterface.VideoCamera];
                if (isBattery) {
                    interfaces.push(ScryptedInterface.Battery);
                }
                const type = abilities.supportDoorbellLight ? ScryptedDeviceType.Doorbell : ScryptedDeviceType.Camera;

                const device: Device = {
                    nativeId,
                    name,
                    providerNativeId: this.nativeId,
                    interfaces,
                    type,
                    info: {
                        manufacturer: 'Reolink',
                        model: channelInfo?.typeInfo,
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
                    deviceData: devicesData[channel],
                });

                logger.debug(`Discovered channel ${channel}: ${name}`);
            } catch (e: any) {
                logger.debug(`Error processing channel ${channel}: ${e?.message || String(e)}`);
            }
        }

        logger.log(`Channel discovery completed. Found ${this.discoveredDevices.size} devices.`);
    }

    async discoverDevices(scan?: boolean): Promise<DiscoveredDevice[]> {
        if (scan) {
            await this.syncEntitiesFromRemote();
        }

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
        const { channelStatus } = entry.deviceData;

        const { ReolinkBaichuanApi } = await import("@apocaliss92/reolink-baichuan-js");
        const transport = 'tcp';
        const uid = channelStatus?.uid;
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
        this.console.log('Adopted device', entry, device?.name);
        const { username, password, ipAddress } = this.storageSettings.values;

        device.storageSettings.values.rtspChannel = entry.rtspChannel;
        device.classes = objects;
        device.presets = presets;
        device.storageSettings.values.username = username;
        device.storageSettings.values.password = password;
        device.storageSettings.values.rtspChannel = entry.rtspChannel;
        device.storageSettings.values.ipAddress = ipAddress;
        device.storageSettings.values.capabilities = capabilities;
        device.storageSettings.values.uid = entry.deviceData.channelStatus.uid;
        device.storageSettings.values.isFromNvr = true;

        this.discoveredDevices.delete(adopt.nativeId);
        return device?.id;
    }
}

