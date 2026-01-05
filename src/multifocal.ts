import type { DeviceInfoResponse, ReolinkBaichuanApi, ReolinkCgiApi, ReolinkSimpleEvent } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { AdoptDevice, Device, DeviceDiscovery, DeviceProvider, DiscoveredDevice, Reboot, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { BaseBaichuanClass, type BaichuanConnectionConfig, type BaichuanConnectionCallbacks } from "./baichuan-base";
import { ReolinkNativeCamera } from "./camera";
import { ReolinkNativeBatteryCamera } from "./camera-battery";
import { normalizeUid, type BaichuanTransport } from "./connect";
import ReolinkNativePlugin from "./main";
import { getDeviceInterfaces, updateDeviceInfo } from "./utils";

export class ReolinkNativeMultiFocalDevice extends BaseBaichuanClass implements Settings, DeviceDiscovery, DeviceProvider, Reboot {
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
        uid: {
            title: 'UID',
            description: 'Reolink UID (required for UDP/battery multi-focal devices)',
            type: 'string',
            hide: true,
            onPut: async () => await this.reinit()
        },
        diagnosticsRun: {
            subgroup: 'Diagnostics',
            title: 'Run Diagnostics',
            description: 'Collect diagnostics and display results in logs.',
            type: 'button',
            immediate: true,
            onPut: async () => {
                await this.runDiagnostics();
            },
        },
    });
    plugin: ReolinkNativePlugin;
    protected readonly protocol: BaichuanTransport;
    discoveredDevices = new Map<string, {
        device: Device;
        description: string;
        rtspChannel: number;
        deviceData: DeviceInfoResponse;
    }>();
    cameraNativeMap = new Map<string, ReolinkNativeCamera | ReolinkNativeBatteryCamera>();
    private channelToNativeIdMap = new Map<number, string>();
    processing = false;
    private syncInProgress = false;
    private syncPromise: Promise<void> | undefined;
    private initReinitTimeout: NodeJS.Timeout | undefined;

    constructor(nativeId: string, plugin: ReolinkNativePlugin, transport: BaichuanTransport = 'tcp') {
        super(nativeId);
        this.plugin = plugin;
        this.protocol = transport;

        this.scheduleInit();
    }

    async reboot(): Promise<void> {
        const api = await this.ensureBaichuanClient();
        await api.reboot();
    }

    // BaseBaichuanClass abstract methods implementation
    protected getConnectionConfig(): BaichuanConnectionConfig {
        const { ipAddress, username, password, uid } = this.storageSettings.values;
        if (!ipAddress || !username || !password) {
            throw new Error('Missing device credentials');
        }

        const normalizedUid = this.protocol === 'udp' ? normalizeUid(uid) : undefined;

        if (this.protocol === 'udp' && !normalizedUid) {
            throw new Error('UID is required for UDP multi-focal devices (BCUDP)');
        }

        return {
            host: ipAddress,
            username,
            password,
            uid: normalizedUid,
            transport: this.protocol,
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
            onSimpleEvent: (ev) => this.forwardNativeEvent(ev),
            getEventSubscriptionEnabled: () => true,
        };
    }

    protected isDebugEnabled(): boolean {
        return this.storageSettings.values.debugEvents;
    }

    protected getDeviceName(): string {
        return this.name || 'Multi-Focal Device';
    }

    async reinit(): Promise<void> {
        // Cancel any pending init/reinit
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
            const logger = this.getBaichuanLogger();
            if (isReinit) {
                logger.log('Reinitializing multi-focal device...');
                await this.cleanupBaichuanApi();
            }
            await this.init();
            this.initReinitTimeout = undefined;
        }, isReinit ? 500 : 2000);
    }

    async init(): Promise<void> {
        const logger = this.getBaichuanLogger();
        try {
            // Update UID setting visibility based on transport
            this.storageSettings.settings.uid.hide = this.protocol === 'tcp';

            logger.debug('Initializing: ensuring Baichuan client...');
            await this.ensureBaichuanClient();

            logger.debug('Initializing: updating device info...');
            await this.updateDeviceInfo();

            logger.debug('Initializing: subscribing to events...');
            await this.subscribeToEvents();

            logger.debug('Initializing: discovering devices...');
            await this.discoverDevices(true);

            logger.log('Initialization completed successfully');
        } catch (e) {
            logger.error('Failed to initialize multi-focal device', e);
            // Log more details about the error
            if (e instanceof Error) {
                logger.error(`Error message: ${e.message}`);
                logger.error(`Error stack: ${e.stack}`);
            } else {
                logger.error(`Error details: ${JSON.stringify(e)}`);
            }
        }
    }

    async updateDeviceInfo(): Promise<void> {
        const logger = this.getBaichuanLogger();
        try {
            const api = await this.ensureBaichuanClient();
            const deviceData = await api.getInfo();

            await updateDeviceInfo({
                device: this,
                deviceData,
                ipAddress: this.storageSettings.values.ipAddress,
            });

            logger.log(`Device info updated: ${JSON.stringify(deviceData)}`);
        } catch (e) {
            logger.warn('Failed to fetch device info', e);
        }
    }

    async syncEntitiesFromRemote() {
        // If sync is already in progress, wait for it to complete
        if (this.syncInProgress && this.syncPromise) {
            const logger = this.getBaichuanLogger();
            logger.debug('Sync already in progress, waiting for completion...');
            await this.syncPromise;
            return;
        }

        // Start new sync
        this.syncInProgress = true;
        this.syncPromise = (async () => {
            const api = await this.ensureBaichuanClient();
            const logger = this.getBaichuanLogger();

            try {
            // const channelsInfo = await api.getNvrChannelsInfo();
            // const deviceInfo = await api.getInfo();
            const { support } = await api.getDeviceCapabilities();
            const channelNum = support?.channelNum ?? 1;
            logger.log(`Sync entities from remote for ${channelNum} channels`);
            const channels = Array.from({ length: channelNum }, (_, i) => i + 1);

            const multifocalInfo = await api.getDualLensChannelInfo();

            logger.log(`Multichannel info: ${JSON.stringify(multifocalInfo)}`);

            // if (channelNum === 2) {

            // }

            for (const channel of channels) {
                //     try {
                //         const name = deviceInfo?.name || `Channel ${channel}`;
                //         const uid = deviceInfo?.uid;
                //         const isBattery = !!(abilities?.battery?.ver ?? 0);

                //         const nativeId = this.buildNativeId(channel, uid, isBattery);
                //         const interfaces = [ScryptedInterface.VideoCamera];
                //         if (isBattery) {
                //             interfaces.push(ScryptedInterface.Battery);
                //         }
                //         const type = abilities.supportDoorbellLight ? ScryptedDeviceType.Doorbell : ScryptedDeviceType.Camera;

                //         const device: Device = {
                //             nativeId,
                //             name,
                //             providerNativeId: this.nativeId,
                //             interfaces,
                //             type,
                //             info: {
                //                 manufacturer: 'Reolink',
                //                 model: channelInfo?.typeInfo,
                //                 serialNumber: uid,
                //             }
                //         };

                //         this.channelToNativeIdMap.set(channel, nativeId);

                //         if (sdk.deviceManager.getNativeIds().includes(nativeId)) {
                //             continue;
                //         }

                //         if (this.discoveredDevices.has(nativeId)) {
                //             continue;
                //         }

                //         this.discoveredDevices.set(nativeId, {
                //             device,
                //             description: `${name} (Channel ${channel})`,
                //             rtspChannel: channel,
                //             deviceData: devicesData[channel],
                //         });

                //         logger.debug(`Discovered channel ${channel}: ${name}`);
                //     } catch (e: any) {
                //         logger.debug(`Error processing channel ${channel}: ${e?.message || String(e)}`);
                //     }
            }

            // logger.log(`Channel discovery completed. ${JSON.stringify({ devicesData, channels })}`);
            } catch (e) {
                logger.error('Failed to sync entities from remote', e);
                if (e instanceof Error) {
                    logger.error(`Error in syncEntitiesFromRemote: ${e.message}`);
                    logger.error(`Stack: ${e.stack}`);
                } else {
                    logger.error(`Error details: ${JSON.stringify(e)}`);
                }
                throw e;
            } finally {
                this.syncInProgress = false;
                this.syncPromise = undefined;
            }
        })();

        await this.syncPromise;
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
        const transport = this.protocol;
        const uid = channelStatus?.uid || this.storageSettings.values.uid;
        // For battery cameras or UDP transport, use UID if available
        const normalizedUid = (isBattery || transport === 'udp') && uid ? normalizeUid(uid) : undefined;
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
        if (device instanceof ReolinkNativeCamera || device instanceof ReolinkNativeBatteryCamera) {
            device.storageSettings.values.ipAddress = this.storageSettings.values.ipAddress;
            device.storageSettings.values.username = this.storageSettings.values.username;
            device.storageSettings.values.password = this.storageSettings.values.password;
            device.storageSettings.values.rtspChannel = entry.rtspChannel;
            // Set multiFocalDevice reference through options (similar to how NVR does it)
            (device).options = { ...(device).options, multiFocalDevice: this, nvrDevice: undefined };
            device.classes = objects;
            device.presets = presets;
        }

        return adopt.nativeId;
    }

    async getDevice(nativeId: string): Promise<ReolinkNativeCamera | ReolinkNativeBatteryCamera> {
        if (this.cameraNativeMap.has(nativeId)) {
            return this.cameraNativeMap.get(nativeId)!;
        }

        const entry = this.discoveredDevices.get(nativeId);
        if (!entry) {
            throw new Error(`Device ${nativeId} not found`);
        }

        const isBattery = entry.device.interfaces.includes(ScryptedInterface.Battery);
        const cameraNativeId = entry.device.nativeId;
        const camera = isBattery
            ? new ReolinkNativeBatteryCamera(cameraNativeId, this.plugin, { type: 'battery', multiFocalDevice: this, nvrDevice: undefined })
            : new ReolinkNativeCamera(cameraNativeId, this.plugin, { type: 'regular', multiFocalDevice: this, nvrDevice: undefined });

        this.cameraNativeMap.set(nativeId, camera);
        return camera;
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

    buildNativeId(channel: number, uid?: string, isBattery?: boolean): string {
        const serialNumber = uid || this.storageSettings.values.ipAddress || 'unknown';
        const suffix = isBattery ? '-battery-cam' : '-cam';
        return `${serialNumber}-channel${channel}${suffix}`;
    }

    forwardNativeEvent(ev: ReolinkSimpleEvent): void {
        if (this.processing) {
            return;
        }

        const logger = this.getBaichuanLogger();
        const channel = ev?.channel;

        if (channel === undefined) {
            logger.debug('Event missing channel, ignoring');
            return;
        }

        const nativeId = this.channelToNativeIdMap.get(channel);
        if (!nativeId) {
            logger.debug(`No camera found for channel ${channel}, ignoring event`);
            return;
        }

        const camera = this.cameraNativeMap.get(nativeId);
        if (!camera) {
            logger.debug(`Camera ${nativeId} not yet initialized, ignoring event`);
            return;
        }

        // Forward event to camera
        if (camera.onSimpleEvent) {
            camera.onSimpleEvent(ev);
        }
    }

    async subscribeToAllEvents(): Promise<void> {
        const logger = this.getBaichuanLogger();
        logger.log('Subscribed to all events for multi-focal device cameras');
        await this.subscribeToEvents();
    }

    private async runDiagnostics(): Promise<void> {
        const logger = this.getBaichuanLogger();
        logger.log(`Starting Multifocal diagnostics...`);

        try {
            const { ipAddress, username, password } = this.storageSettings.values;
            if (!ipAddress || !username || !password) {
                throw new Error('Missing device credentials');
            }

            const api = await this.ensureBaichuanClient();

            const multifocalDiagnostics = await api.collectMultifocalDiagnostics(logger);

            logger.log(`NVR diagnostics completed successfully.`);
            logger.log(JSON.stringify(multifocalDiagnostics));
        } catch (e) {
            logger.error('Failed to run NVR diagnostics', e);
            throw e;
        }
    }
}

