import type { DeviceCapabilities, DualLensChannelAnalysis, ReolinkSimpleEvent } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { Device, DeviceProvider, MediaObject, Reboot, ScryptedDeviceType, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { type BaichuanConnectionCallbacks } from "./baichuan-base";
import { ReolinkNativeCamera } from "./camera";
import { ReolinkNativeBatteryCamera } from "./camera-battery";
import { CameraType, CommonCameraMixin } from "./common";
import ReolinkNativePlugin from "./main";
import { batteryCameraSuffix, cameraSuffix, getDeviceInterfaces, updateDeviceInfo } from "./utils";

export class ReolinkNativeMultiFocalDevice extends CommonCameraMixin implements Settings, DeviceProvider, Reboot {
    plugin: ReolinkNativePlugin;
    cameraNativeMap = new Map<string, ReolinkNativeCamera | ReolinkNativeBatteryCamera>();
    private channelToNativeIdMap = new Map<number, string>();
    private initReinitTimeout: NodeJS.Timeout | undefined;
    isBattery: boolean;

    constructor(nativeId: string, plugin: ReolinkNativePlugin, type: CameraType) {
        super(nativeId, plugin, { type });
        this.plugin = plugin;

        this.scheduleInit();
    }

    getAbilities(): DeviceCapabilities {
        const { capabilities } = this.storageSettings.values;

        return {
            ...capabilities,
            hasPan: false,
            hasTilt: false,
            hasZoom: false,
            hasPresets: false,
            hasIntercom: false,
        }
    }

    async reboot(): Promise<void> {
        const api = await this.ensureBaichuanClient();
        await api.reboot();
    }

    takePicture(options?: any): Promise<MediaObject> {
        throw new Error("Method not implemented.");
    }

    getPictureOptions(): Promise<any[]> {
        throw new Error("Method not implemented.");
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
        return this.storageSettings.values.debugEvents || false;
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
                logger,
            });
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

        // TODO: Remove this after debugging
        logger.log(`Multichannel info: ${JSON.stringify({ multifocalInfo, capabilities, support, abilities, features, objects, presets })}`);
        // logger.debug(`Multichannel info: ${JSON.stringify({ multifocalInfo, capabilities, support, abilities, features, objects, presets })}`);

        for (const channelInfo of multifocalInfo?.channels ?? []) {
            const { channel, lensType } = channelInfo;

            const name = `${this.name} - ${lensType}`;
            const nativeId = `${this.nativeId}-channel${channel}${this.isBattery ? batteryCameraSuffix : cameraSuffix}`;

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

            // TODO: Remove this after debugging
            logger.log(`Discovering lens device ${nativeId}: ${JSON.stringify({ interfaces, deviceCapabilities })}`);

            const camera = await this.getDevice(nativeId);

            if (!camera) {
                logger.error(`Failed to get device ${nativeId}`);
                continue;
            }

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

        await super.reportDevices();
    }

    async getDevice(nativeId: string) {
        if (nativeId.endsWith(cameraSuffix) || nativeId.endsWith(batteryCameraSuffix)) {
            let device = this.cameraNativeMap.get(nativeId);
            if (!device) {
                if (nativeId.endsWith(batteryCameraSuffix)) {
                    device = new ReolinkNativeBatteryCamera(nativeId, this.plugin, undefined, this);
                } else {
                    device = new ReolinkNativeCamera(nativeId, this.plugin, undefined, this);
                }
            }
            return device;
        } else {
            return super.getDevice(nativeId);
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
        super.releaseDevice(id, nativeId);
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

        camera.onSimpleEvent(ev);
    }

    async unsubscribeFromAllEvents(): Promise<void> {
        await super.unsubscribeFromEvents();
    }

    public async runDiagnostics(): Promise<void> {
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

