import type { DeviceCapabilities, DualLensChannelAnalysis, ReolinkSimpleEvent } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { Device, DeviceProvider, Reboot, ScryptedDeviceType, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { BaseBaichuanClass, type BaichuanConnectionCallbacks, type BaichuanConnectionConfig } from "./baichuan-base";
import { ReolinkNativeCamera } from "./camera";
import { ReolinkNativeBatteryCamera } from "./camera-battery";
import { normalizeUid } from "./connect";
import ReolinkNativePlugin from "./main";
import { batteryCameraSuffix, cameraSuffix, getDeviceInterfaces, updateDeviceInfo } from "./utils";

export class ReolinkNativeMultiFocalDevice extends BaseBaichuanClass implements Settings, DeviceProvider, Reboot {
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
        protocol: {
            type: 'string',
            hide: true,
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
        multifocalInfo: {
            json: true,
            hide: true,
        },
        capabilities: {
            json: true,
            hide: true,
        }
    });

    plugin: ReolinkNativePlugin;
    cameraNativeMap = new Map<string, ReolinkNativeCamera | ReolinkNativeBatteryCamera>();
    private channelToNativeIdMap = new Map<number, string>();
    private initReinitTimeout: NodeJS.Timeout | undefined;
    isBattery: boolean;

    constructor(nativeId: string, plugin: ReolinkNativePlugin) {
        super(nativeId);
        this.plugin = plugin;

        this.isBattery = this.storageSettings.values.protocol === 'udp';

        this.scheduleInit();
    }

    async reboot(): Promise<void> {
        const api = await this.ensureBaichuanClient();
        await api.reboot();
    }

    protected getConnectionConfig(): BaichuanConnectionConfig {
        const { ipAddress, username, password, uid } = this.storageSettings.values;
        if (!ipAddress || !username || !password) {
            throw new Error('Missing device credentials');
        }

        const { protocol } = this.storageSettings.values;

        const normalizedUid = this.isBattery ? normalizeUid(uid) : undefined;

        if (protocol === 'udp' && !normalizedUid) {
            throw new Error('UID is required for UDP multi-focal devices (BCUDP)');
        }

        return {
            host: ipAddress,
            username,
            password,
            uid: normalizedUid,
            transport: protocol,
            logger: this.console,
        };
    }

    protected getConnectionCallbacks(): BaichuanConnectionCallbacks {
        return {
            onError: undefined, // Use default error handling
            onClose: async () => {
                // Reinit after cleanup
                await this.reinit();
                if (!this.isBattery) {
                    setTimeout(async () => {
                        try {
                            await this.subscribeToEvents();
                        } catch (e) {
                            const logger = this.getBaichuanLogger();
                            logger.warn('Failed to resubscribe to events after reconnection', e);
                        }
                    }, 1000);
                }
            },
            onSimpleEvent: (ev) => this.forwardNativeEvent(ev),
            getEventSubscriptionEnabled: () => true,
        };
    }

    protected async onBeforeCleanup(): Promise<void> {
        await this.unsubscribeFromAllEvents();
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
            this.storageSettings.settings.uid.hide = !this.isBattery;

            await this.ensureBaichuanClient();
            await this.updateDeviceInfo();
            await this.reportDevices();
            await this.subscribeToEvents();
        } catch (e) {
            logger.error('Failed to initialize multi-focal device', e);
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

    getInterfaces(channel: number) {
        const logger = this.getBaichuanLogger();
        const { capabilities: caps, multifocalInfo } = this.storageSettings.values;
        const channelInfo = (multifocalInfo as DualLensChannelAnalysis).channels.find(c => c.channel === channel);

        const capabilities: DeviceCapabilities = {
            ...caps,
            hasPan: channelInfo.hasPan,
            hasTilt: channelInfo.hasTilt,
            hasZoom: channelInfo.hasZoom,
            hasPresets: channelInfo.hasPresets,
            hasIntercom: channelInfo.hasIntercom,
        };

        const { interfaces } = getDeviceInterfaces({
            capabilities,
            logger,
        });

        return { interfaces, capabilities };
    }

    async reportDevices(): Promise<void> {
        const api = await this.ensureBaichuanClient();
        const logger = this.getBaichuanLogger();
        const { username, password, ipAddress, uid } = this.storageSettings.values;

        const { capabilities, support, abilities, features, objects, presets } = await api.getDeviceCapabilities();

        const multifocalInfo = await api.getDualLensChannelInfo();
        logger.log(`Sync entities from remote for ${multifocalInfo.channels.length} channels`);

        this.storageSettings.values.multifocalInfo = multifocalInfo;
        this.storageSettings.values.capabilities = capabilities;

        logger.debug(`Multichannel info: ${JSON.stringify({ multifocalInfo, capabilities, support, abilities, features, objects, presets })}`);

        for (const channelInfo of multifocalInfo?.channels ?? []) {
            const { channel, lensType } = channelInfo;

            const name = `${this.name} - ${lensType}`;
            const nativeId = this.buildNativeId(channel);

            this.channelToNativeIdMap.set(channel, nativeId);
            const { interfaces, capabilities: deviceCapabilities } = this.getInterfaces(channel);

            const device: Device = {
                providerNativeId: this.nativeId,
                name,
                nativeId,
                info: {
                    ...this.info,
                    metadata: {
                        channel,
                        lensType
                    }
                },
                interfaces,
                type: ScryptedDeviceType.Camera,
            };

            await sdk.deviceManager.onDeviceDiscovered(device);

            const camera = await this.getDevice(nativeId);

            camera.storageSettings.values.rtspChannel = channel;
            camera.classes = objects;
            camera.presets = presets;
            camera.storageSettings.values.username = username;
            camera.storageSettings.values.password = password;
            camera.storageSettings.values.ipAddress = ipAddress;
            camera.storageSettings.values.capabilities = deviceCapabilities;
            if (this.isBattery) {
                camera.storageSettings.values.uid = uid;
            }
        }
    }

    async getDevice(nativeId: string) {
        let device = this.cameraNativeMap.get(nativeId);
        if (!device) {
            if (nativeId.endsWith(batteryCameraSuffix)) {
                device = new ReolinkNativeBatteryCamera(nativeId, this.plugin, undefined, this);
            } else {
                device = new ReolinkNativeCamera(nativeId, this.plugin, undefined, this);
            }
        }

        return device;
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

    buildNativeId(channel: number): string {
        const { protocol } = this.storageSettings.values;
        return `${this.nativeId}-channel${channel}${protocol === "udp" ? batteryCameraSuffix : cameraSuffix}`;
    }

    forwardNativeEvent(ev: ReolinkSimpleEvent): void {
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
    async unsubscribeFromAllEvents(): Promise<void> {
        await super.unsubscribeFromEvents();
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

