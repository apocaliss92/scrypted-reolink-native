import type { DeviceCapabilities, DualLensChannelAnalysis, ReolinkBaichuanApi, ReolinkSimpleEvent } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { Device, DeviceProvider, Reboot, ScryptedDeviceType, Settings } from "@scrypted/sdk";
import { ReolinkNativeCamera } from "./camera";
import { ReolinkNativeBatteryCamera } from "./camera-battery";
import { CameraType, CommonCameraMixin } from "./common";
import ReolinkNativePlugin from "./main";
import { batteryCameraSuffix, cameraSuffix, getDeviceInterfaces } from "./utils";
import { ReolinkNativeNvrDevice } from "./nvr";

export class ReolinkNativeMultiFocalDevice extends CommonCameraMixin implements Settings, DeviceProvider, Reboot {
    plugin: ReolinkNativePlugin;
    cameraNativeMap = new Map<string, ReolinkNativeCamera | ReolinkNativeBatteryCamera>();
    private channelToNativeIdMap = new Map<number, string>();
    private initReinitTimeout: NodeJS.Timeout | undefined;
    private initInProgress: boolean = false;
    private reportDevicesInProgress: boolean = false;
    isBattery: boolean;

    constructor(nativeId: string, plugin: ReolinkNativePlugin, type: CameraType, nvrDevice?: ReolinkNativeNvrDevice) {
        super(nativeId, plugin, { type, nvrDevice });
        this.plugin = plugin;
    }

    async parentInit(): Promise<void> {
        // Set up settings visibility first (synchronously)
        this.storageSettings.settings.socketApiDebugLogs.hide = !!this.nvrDevice;
        this.storageSettings.settings.clipsSource.hide = !this.nvrDevice;
        this.storageSettings.settings.clipsSource.defaultValue = this.nvrDevice ? "NVR" : "Device";
        this.storageSettings.settings.videoclipsRegularChecks.defaultValue = this.isBattery ? 120 : 30;
        this.storageSettings.settings.batteryUpdateIntervalMinutes.hide = !this.isBattery;
        this.storageSettings.settings.lowThresholdBatteryRecording.hide = !this.isBattery;
        this.storageSettings.settings.highThresholdBatteryRecording.hide = !this.isBattery;
        this.storageSettings.settings.pipPosition.hide = !this.isMultiFocal;
        this.storageSettings.settings.pipSize.hide = !this.isMultiFocal;
        this.storageSettings.settings.pipMargin.hide = !this.isMultiFocal;
        this.storageSettings.settings.widerChannel.hide = !this.isMultiFocal;
        this.storageSettings.settings.teleChannel.hide = !this.isMultiFocal;
        this.storageSettings.settings.uid.hide = !this.isBattery;
        this.storageSettings.settings.discoveryMethod.hide = !this.isBattery && !this.nvrDevice;

        // Handle battery camera mixins setup
        if (this.isBattery && !this.storageSettings.values.mixinsSetup) {
            const logger = this.getBaichuanLogger();
            try {
                const device = sdk.systemManager.getDeviceById<Settings>(this.id);
                if (device) {
                    logger.log('Disabling prebuffer and snapshots from prebuffer');
                    await device.putSetting('prebuffer:enabledStreams', '[]');
                    await device.putSetting('snapshot:snapshotsFromPrebuffer', 'Disabled');
                    this.storageSettings.values.mixinsSetup = true;
                }
            } catch (e) {
                logger.warn('Failed to setup mixins during parentInit', e?.message || String(e));
            }
        }

        // Call our init() method which handles the actual initialization
        // This includes ensureClient(), reportDevices(), and subscribeToEvents()
        await this.init();
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

    protected async onBeforeCleanup(): Promise<void> {
        await this.unsubscribeFromAllEvents();
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

        // Prevent multiple simultaneous init calls
        if (this.initInProgress) {
            return;
        }

        this.initInProgress = true;
        try {
            this.storageSettings.settings.uid.hide = !this.isBattery;

            await this.ensureClient();
            await this.reportDevices();
            await this.subscribeToEvents();
        } catch (e) {
            logger.error('Failed to initialize multi-focal device', e?.message || String(e));
        } finally {
            this.initInProgress = false;
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
        const logger = this.getBaichuanLogger();

        // Prevent multiple simultaneous reportDevices calls
        if (this.reportDevicesInProgress) {
            return;
        }

        this.reportDevicesInProgress = true;
        try {
            const api = await this.ensureClient();
            const { username, password, ipAddress, uid, rtspChannel } = this.storageSettings.values;

            const { capabilities, support, abilities, features, objects, presets } = await api.getDeviceCapabilities();

            // if(this.nvrDevice) {

            // } else {

            // }
            const multifocalInfo = await api.getDualLensChannelInfo(rtspChannel, {
                onNvr: !!this.nvrDevice
            });
            logger.log(`Sync entities from remote for ${multifocalInfo.channels.length} channels`);
            logger.log({ multifocalInfo, rtspChannel, onNvr: !!this.nvrDevice });

            this.storageSettings.values.multifocalInfo = multifocalInfo;
            this.storageSettings.values.capabilities = capabilities;

            for (const channelInfo of multifocalInfo?.channels ?? []) {
                const { channel, lensType, variantType } = channelInfo;

                const name = `${this.name} - ${lensType}`;
                const nativeId = `${this.nativeId}-${lensType}${this.isBattery ? batteryCameraSuffix : cameraSuffix}`;

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
                camera.storageSettings.values.variantType = variantType;
                camera.storageSettings.values.rtspChannel = channel;
                camera.storageSettings.values.capabilities = deviceCapabilities;
                camera.storageSettings.values.uid = uid;
            }

            await super.reportDevices();
        } catch (e) {
            logger.error('Failed to report devices', e?.message || String(e));
            throw e;
        } finally {
            this.reportDevicesInProgress = false;
        }
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

            const api = await this.ensureClient();

            const multifocalDiagnostics = await api.collectMultifocalDiagnostics(logger);

            logger.log(`NVR diagnostics completed successfully.`);
            logger.log(JSON.stringify(multifocalDiagnostics));
        } catch (e) {
            logger.error('Failed to run NVR diagnostics', e);
            throw e;
        }
    }

    async ensureClient(): Promise<ReolinkBaichuanApi> {
        if (this.nvrDevice) {
            return await this.nvrDevice.ensureBaichuanClient();
        }

        // Use base class implementation
        return await this.ensureBaichuanClient();
    }
}

