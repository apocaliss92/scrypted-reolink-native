import type { DeviceInfoResponse, DeviceInputData, ReolinkBaichuanApi, ReolinkCgiApi, ReolinkSimpleEvent } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { AdoptDevice, Device, DeviceDiscovery, DeviceProvider, DiscoveredDevice, Reboot, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { ReolinkNativeCamera } from "./camera";
import { ReolinkNativeBatteryCamera } from "./camera-battery";
import { normalizeUid } from "./connect";
import ReolinkNativePlugin from "./main";
import { getDeviceInterfaces, updateDeviceInfo } from "./utils";

export class ReolinkNativeNvrDevice extends ScryptedDeviceBase implements Settings, DeviceDiscovery, DeviceProvider, Reboot {
    storageSettings = new StorageSettings(this, {
        debugEvents: {
            title: 'Debug Events',
            type: 'boolean',
            immediate: true,
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
    baichuanApi: ReolinkBaichuanApi | undefined;
    baichuanApiPromise: Promise<ReolinkBaichuanApi> | undefined;
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
    processing = false;
    private eventSubscriptionActive = false;
    private errorListener?: (err: unknown) => void;
    private closeListener?: () => void;

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

    getLogger() {
        return this.console;
    }

    /**
     * Centralized cleanup method for Baichuan API
     * Removes all listeners, closes connection, and resets state
     */
    private async cleanupBaichuanApi(): Promise<void> {
        if (!this.baichuanApi) {
            return;
        }

        const api = this.baichuanApi;

        // Unsubscribe from events first
        await this.unsubscribeFromAllEvents();

        // Remove all listeners
        try {
            api.client.off("close", this.closeListener);
        } catch {
            // ignore
        }

        try {
            api.client.off("error", this.errorListener);
        } catch {
            // ignore
        }

        // Close connection if still connected
        try {
            if (api.client.isSocketConnected()) {
                await api.close();
            }
        } catch {
            // ignore
        }

        // Reset state
        this.baichuanApi = undefined;
        this.baichuanApiPromise = undefined;
    }

    /**
     * Attach error and close listeners to Baichuan API
     */
    private attachBaichuanListeners(api: ReolinkBaichuanApi): void {
        const logger = this.getLogger();

        // Error listener
        this.errorListener = (err: unknown) => {
            const msg = (err as any)?.message || (err as any)?.toString?.() || String(err);

            // Only log if it's not a recoverable error to avoid spam
            if (typeof msg === 'string' && (
                msg.includes('Baichuan socket closed') ||
                msg.includes('Baichuan UDP stream closed') ||
                msg.includes('Not running')
            )) {
                logger.debug(`[NVR BaichuanClient] error (recoverable): ${msg}`);
                return;
            }
            logger.error(`[NVR BaichuanClient] error: ${msg}`);
        };

        // Close listener
        this.closeListener = async () => {
            try {
                const wasConnected = api.client.isSocketConnected();
                const wasLoggedIn = api.client.loggedIn;
                logger.log(`[NVR BaichuanClient] Connection state before close: connected=${wasConnected}, loggedIn=${wasLoggedIn}`);

                // Try to get last message info if available
                const client = api.client as any;
                if (client?.lastRx || client?.lastTx) {
                    logger.log(`[NVR BaichuanClient] Last message info: lastRx=${JSON.stringify(client.lastRx)}, lastTx=${JSON.stringify(client.lastTx)}`);
                }
            }
            catch (e) {
                logger.debug(`[NVR BaichuanClient] Could not get connection state: ${e}`);
            }

            // Cleanup and reinit
            await this.cleanupBaichuanApi();
            await this.reinit();
        };

        // Attach listeners
        api.client.on("error", this.errorListener);
        api.client.on("close", this.closeListener);
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
        await this.cleanupBaichuanApi();
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

    async onSimpleEventHandler(ev: ReolinkSimpleEvent) {
        const logger = this.getLogger();
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

            // Find camera with matching channel
            let targetCamera: ReolinkNativeCamera | ReolinkNativeBatteryCamera | undefined;
            for (const camera of this.cameraNativeMap.values()) {
                if (camera && camera.storageSettings.values.rtspChannel === channel) {
                    targetCamera = camera;
                    break;
                }
            }

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
            logger.warn('Error in NVR onSimpleEvent handler', e);
        }
    }

    async ensureBaichuanClient(): Promise<ReolinkBaichuanApi> {
        // Reuse existing client if socket is still connected and logged in
        if (this.baichuanApi && this.baichuanApi.client.isSocketConnected() && this.baichuanApi.client.loggedIn) {
            return this.baichuanApi;
        }

        // Prevent concurrent login storms
        if (this.baichuanApiPromise) return await this.baichuanApiPromise;

        this.baichuanApiPromise = (async () => {
            const { ipAddress, username, password } = this.storageSettings.values;
            if (!ipAddress || !username || !password) {
                throw new Error('Missing NVR credentials');
            }

            // Clean up old client if exists
            if (this.baichuanApi) {
                await this.cleanupBaichuanApi();
            }

            // Create new Baichuan client
            const { ReolinkBaichuanApi } = await import("@apocaliss92/reolink-baichuan-js");
            this.baichuanApi = new ReolinkBaichuanApi({
                host: ipAddress,
                username,
                password,
                transport: 'tcp',
                logger: this.getLogger(),
            });

            await this.baichuanApi.login();

            // Verify socket is connected before returning
            if (!this.baichuanApi.client.isSocketConnected()) {
                throw new Error('Socket not connected after login');
            }

            // Attach listeners (error and close)
            this.attachBaichuanListeners(this.baichuanApi);

            return this.baichuanApi;
        })();

        try {
            return await this.baichuanApiPromise;
        }
        finally {
            // Allow future reconnects and avoid pinning rejected promises
            this.baichuanApiPromise = undefined;
        }
    }

    async subscribeToAllEvents(): Promise<void> {
        const logger = this.getLogger();

        // If already subscribed and connection is valid, return
        if (this.eventSubscriptionActive && this.baichuanApi) {
            if (this.baichuanApi.client.isSocketConnected() && this.baichuanApi.client.loggedIn) {
                logger.log('Event subscription already active');
                return;
            }
            // Connection is invalid, reset subscription state
            this.eventSubscriptionActive = false;
        }

        // Unsubscribe first if handler exists (idempotent)
        await this.unsubscribeFromAllEvents();

        // Get Baichuan client connection
        const api = await this.ensureBaichuanClient();

        // Verify connection is ready
        if (!api.client.isSocketConnected() || !api.client.loggedIn) {
            logger.warn('Cannot subscribe to events: connection not ready');
            return;
        }

        // Subscribe to events
        try {
            await api.onSimpleEvent(this.onSimpleEventHandler);
            this.eventSubscriptionActive = true;
            logger.log('Subscribed to all events for NVR cameras');
        }
        catch (e) {
            logger.warn('Failed to subscribe to events', e);
            this.eventSubscriptionActive = false;
        }
    }

    async unsubscribeFromAllEvents(): Promise<void> {
        const logger = this.getLogger();

        // Only unsubscribe if we have an active subscription
        if (this.eventSubscriptionActive && this.baichuanApi) {
            try {
                this.baichuanApi.offSimpleEvent(this.onSimpleEventHandler);
                logger.log('Unsubscribed from all events');
            }
            catch (e) {
                logger.warn('Error unsubscribing from events', e);
            }
        }

        this.eventSubscriptionActive = false;
    }

    async init() {
        const api = await this.ensureClient();
        const logger = this.getLogger();
        await this.updateDeviceInfo();

        // Subscribe to events for all cameras
        this.subscribeToAllEvents().catch((e) => {
            logger.warn('Failed to subscribe to events during init', e);
        });

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

                const eventsRes = await api.getAllChannelsEvents();

                if (this.storageSettings.values.debugEvents) {
                    logger.debug(`Events call result: ${JSON.stringify(eventsRes)}`);
                }
                this.cameraNativeMap.forEach((camera) => {
                    if (camera) {
                        const channel = camera.storageSettings.values.rtspChannel;
                        const cameraEventsData = eventsRes?.parsed[channel];
                        if (cameraEventsData) {
                            camera.processEvents(cameraEventsData);
                        }
                    }
                });

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

