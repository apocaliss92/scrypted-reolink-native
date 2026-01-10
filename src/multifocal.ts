import type { DeviceCapabilities, DualLensChannelAnalysis, NativeVideoStreamVariant, ReolinkBaichuanApi, ReolinkSimpleEvent, StreamProfile } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import type { BaichuanConnectionConfig } from "./baichuan-base";
import sdk, { Device, DeviceProvider, Reboot, ScryptedDeviceType, Settings } from "@scrypted/sdk";
import { ReolinkNativeCamera } from "./camera";
import { ReolinkNativeBatteryCamera } from "./camera-battery";
import { CameraType, CommonCameraMixin } from "./common";
import ReolinkNativePlugin from "./main";
import { batteryCameraSuffix, cameraSuffix, getDeviceInterfaces } from "./utils";
import { ReolinkNativeNvrDevice } from "./nvr";
import { createBaichuanApi } from "./connect";

export class ReolinkNativeMultiFocalDevice extends CommonCameraMixin implements Settings, DeviceProvider, Reboot {
    plugin: ReolinkNativePlugin;
    cameraNativeMap = new Map<string, ReolinkNativeCamera | ReolinkNativeBatteryCamera>();
    private channelToNativeIdMap = new Map<number, string>();
    isBattery: boolean;

    constructor(nativeId: string, plugin: ReolinkNativePlugin, type: CameraType, nvrDevice?: ReolinkNativeNvrDevice) {
        super(nativeId, plugin, { type, nvrDevice });

        this.plugin = plugin;
    }

    protected async onBeforeCleanup(): Promise<void> {
        await this.unsubscribeFromAllEvents();
    }

    protected getDeviceName(): string {
        return this.name || 'Multi-Focal Device';
    }

    async init(): Promise<void> {
        const logger = this.getBaichuanLogger();

        try {
            this.storageSettings.settings.uid.hide = !this.isBattery;

            await this.ensureClient();
            await this.subscribeToEvents();
        } catch (e) {
            logger.error('Failed to initialize multi-focal device', e?.message || String(e));
        }
    }

    getInterfaces(lensType?: NativeVideoStreamVariant) {
        const logger = this.getBaichuanLogger();
        const { capabilities: caps, multifocalInfo } = this.storageSettings.values;

        let capabilities: DeviceCapabilities = { ...caps };

        if (lensType) {
            const channelInfo = (multifocalInfo as DualLensChannelAnalysis).channels.find(c => c.variantType === lensType);

            const hasPtz = channelInfo?.hasPan || channelInfo?.hasTilt || channelInfo?.hasZoom;

            capabilities = {
                ...capabilities,
                hasPan: channelInfo.hasPan,
                hasTilt: channelInfo.hasTilt,
                hasZoom: channelInfo?.hasZoom,
                hasPresets: channelInfo?.hasPresets || hasPtz,
                hasIntercom: channelInfo?.hasIntercom,
                hasPtz,
            };
        }

        const { interfaces } = getDeviceInterfaces({
            capabilities,
            logger,
        });

        logger.debug(`Interfaces found for lens ${lensType}: ${JSON.stringify({ interfaces, capabilities, multifocalInfo })}`);

        return { interfaces, capabilities };
    }

    async reportDevices(): Promise<void> {
        const logger = this.getBaichuanLogger();

        try {
            const api = await this.ensureClient();
            const { username, password, ipAddress, uid, rtspChannel } = this.storageSettings.values;

            const { capabilities, objects, presets } = await api.getDeviceCapabilities(rtspChannel, {
                mergeDualLensOnSameChannel: true,
            });
            const multifocalInfo = await api.getDualLensChannelInfo(rtspChannel, {
                onNvr: !!this.nvrDevice
            });
            logger.log(`Discovering ${multifocalInfo.channels.length} lenses`);
            logger.debug({ multifocalInfo, capabilities });

            this.storageSettings.values.multifocalInfo = multifocalInfo;
            this.storageSettings.values.capabilities = capabilities;

            for (const channelInfo of multifocalInfo?.channels ?? []) {
                const { channel, lensType, variantType } = channelInfo;

                const name = `${this.name} - ${lensType}`;
                const nativeId = `${this.nativeId}-${lensType}${this.isBattery ? batteryCameraSuffix : cameraSuffix}`;

                this.channelToNativeIdMap.set(channel, nativeId);
                const { interfaces, capabilities: deviceCapabilities } = this.getInterfaces();

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

                logger.log(`Discovering lens ${lensType}`);
                logger.debug(`${JSON.stringify({ interfaces, deviceCapabilities })}`)

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
        } catch (e) {
            logger.error('Failed to report devices', e?.message || String(e));
            throw e;
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
            logger.debug(JSON.stringify(multifocalDiagnostics));
        } catch (e) {
            logger.error('Failed to run NVR diagnostics', e?.message || String(e));
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

    protected getStreamClientInputs(): BaichuanConnectionConfig {
        const { ipAddress, username, password } = this.storageSettings.values;
        const debugOptions = this.getBaichuanDebugOptions();

        return {
            host: ipAddress,
            username,
            password,
            transport: this.transport,
            debugOptions,
        };
    }

    /**
     * Create a dedicated Baichuan API session for streaming (used by StreamManager).
     * MultiFocal creates its own socket for stream clients, or delegates to NVR if on NVR.
     */
    async createStreamClient(streamKey: string): Promise<ReolinkBaichuanApi> {
        // If on NVR, delegate to NVR to create the socket
        if (this.nvrDevice) {
            return await this.nvrDevice.createStreamClient(streamKey);
        }

        // Otherwise, use base class createStreamClient which manages stream clients per streamKey
        return await super.createStreamClient(streamKey);
    }
}

