import type { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { Settings, ScryptedDeviceBase, Setting, SettingValue, DeviceDiscovery, AdoptDevice, DiscoveredDevice, Device, ScryptedInterface, ScryptedDeviceType, DeviceProvider, Reboot } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { ReolinkNativeCamera } from "./camera";
import { getDeviceInterfaces } from "./utils";
import ReolinkNativePlugin from "./main";

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
        channelNum: {
            json: true,
            hide: true,
            defaultValue: 1,
        },
    });
    plugin: ReolinkNativePlugin;
    nvrApi: ReolinkBaichuanApi | undefined;
    discoveredDevices = new Map<string, {
        device: Device;
        description: string;
        rtspChannel: number;
    }>();
    lastHubInfoCheck: number | undefined;
    cameraNativeMap = new Map<string, ReolinkNativeCamera>();
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
        await api.reboot();
    }

    getLogger() {
        return this.console;
    }

    async reinit() {
        if (this.nvrApi) {
            try {
                await this.nvrApi.close();
            } catch {
                // ignore
            }
        }
        this.nvrApi = undefined;
    }

    async ensureClient(): Promise<ReolinkBaichuanApi> {
        if (this.nvrApi) {
            try {
                if (this.nvrApi.client.isSocketConnected() && this.nvrApi.client.loggedIn) {
                    return this.nvrApi;
                }
            } catch {
                // Connection check failed, will recreate
            }
        }

        const { ipAddress, username, password } = this.storageSettings.values;
        if (!ipAddress || !username || !password) {
            throw new Error('Missing NVR credentials');
        }

        if (this.nvrApi) {
            try {
                await this.nvrApi.close();
            } catch {
                // ignore
            }
            this.nvrApi = undefined;
        }

        const { ReolinkBaichuanApi } = await import("@apocaliss92/reolink-baichuan-js");
        this.nvrApi = new ReolinkBaichuanApi({
            host: ipAddress,
            username,
            password,
            logger: this.console,
            transport: 'tcp',
        });

        await this.nvrApi.login();
        return this.nvrApi;
    }

    async init() {
        const api = await this.ensureClient();
        const logger = this.getLogger();

        // Get channel count from support info
        const { support } = await api.getDeviceCapabilities(0);
        const channelNum = support?.channelNum ?? 16; // Default to 16 if not available
        this.storageSettings.values.channelNum = channelNum;
        logger.log(`NVR initialized with ${channelNum} channels`);

        setInterval(async () => {
            if (this.processing) {
                return;
            }
            this.processing = true;
            try {
                const now = Date.now();

                if (!this.lastHubInfoCheck || now - this.lastHubInfoCheck > 1000 * 60 * 5) {
                    logger.log('Starting NVR channels discovery');
                    this.lastHubInfoCheck = now;
                    await this.discoverDevices(true);
                }

                // Process events for all discovered cameras
                // Events are handled by individual camera devices via their own subscriptions
            } catch (e) {
                this.console.error('Error on NVR events flow', e);
            } finally {
                this.processing = false;
            }
        }, 1000);
    }

    updateDeviceInfo(deviceInfo: Record<string, string>) {
        const info = this.info || {};
        info.ip = this.storageSettings.values.ipAddress;
        info.serialNumber = deviceInfo?.serialNumber || deviceInfo?.itemNo;
        info.firmware = deviceInfo?.firmwareVersion || deviceInfo?.firmVer;
        info.version = deviceInfo?.hardwareVersion || deviceInfo?.boardInfo;
        info.model = deviceInfo?.type || deviceInfo?.typeInfo;
        info.manufacturer = 'Reolink native';
        info.managementUrl = `http://${info.ip}`;
        this.info = info;
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

    async getDevice(nativeId: string): Promise<ReolinkNativeCamera> {
        let device = this.cameraNativeMap.get(nativeId);

        if (!device) {
            device = new ReolinkNativeCamera(nativeId, this.plugin);
            this.cameraNativeMap.set(nativeId, device);
        }

        return device;
    }

    buildNativeId(channel: number, serialNumber?: string): string {
        if (serialNumber) {
            return `${this.nativeId}-ch${channel}-${serialNumber}`;
        }
        return `${this.nativeId}-ch${channel}`;
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
        const channelNum = this.storageSettings.values.channelNum ?? 16;
        const logger = this.getLogger();

        logger.log(`Discovering channels using getNvrChannelsInfo (maxChannels: ${channelNum})...`);

        // Use getNvrChannelsInfo to get all channels info at once (with CGI fallback)
        const channelsInfo = await api.getNvrChannelsInfo({
            maxChannels: channelNum,
            timeoutMs: 3000,
            source: 'cgi',
        });

        logger.log(`getNvrChannelsInfo completed. Found ${channelsInfo.length} channels.`);

        // Process each channel that was successfully discovered
        for (const channelInfo of channelsInfo) {
            const channel = channelInfo.channel;

            try {
                // Get capabilities for this channel
                const { capabilities, objects } = await api.getDeviceCapabilities(channel);
                
                const name = channelInfo.name || `Channel ${channel}`;
                const serialNumber = channelInfo.uid || `ch${channel}`;
                const nativeId = this.buildNativeId(channel, serialNumber);

                const { interfaces, type } = getDeviceInterfaces({
                    capabilities,
                    logger: this.console,
                });

                const device: Device = {
                    nativeId,
                    name,
                    providerNativeId: this.nativeId,
                    interfaces: this.getCameraInterfaces(),
                    type: ScryptedDeviceType.Camera,
                    info: {
                        manufacturer: 'Reolink native',
                        model: channelInfo.model,
                        serialNumber,
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
                });

                logger.debug(`Discovered channel ${channel}: ${name} (source: ${channelInfo.source})`);
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

        await sdk.deviceManager.onDeviceDiscovered(entry.device);

        const device = await this.getDevice(adopt.nativeId);
        this.console.log('Adopted device', entry, device?.name);
        device.storageSettings.values.rtspChannel = entry.rtspChannel;
        device.storageSettings.values.ipAddress = this.storageSettings.values.ipAddress;
        device.storageSettings.values.username = this.storageSettings.values.username;
        device.storageSettings.values.password = this.storageSettings.values.password;
        const api = await this.ensureClient();
        const { capabilities } = await api.getDeviceCapabilities(entry.rtspChannel);
        device.storageSettings.values.capabilities = capabilities;
        device.updateDeviceInfo();

        this.discoveredDevices.delete(adopt.nativeId);
        return device?.id;
    }
}

