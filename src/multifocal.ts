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
            // subscribeToEvents in common.ts will check if this device has a parent (nvrDevice)
            // and skip subscription if needed - events will be forwarded from parent
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

    /**
     * Forward events received from parent (NVR if child, or directly from Baichuan if standalone)
     * to the MultiFocal device itself AND to ALL lens devices (camera children) of this MultiFocal.
     * This ensures that:
     * 1. The MultiFocal device itself receives events (it can have event handling capabilities)
     * 2. All lenses receive the events, even if they share the same channel
     *    (e.g., wide and tele on the same channel on NVR).
     * Only the root device (NVR or standalone MultiFocal) subscribes to events,
     * and events are forwarded down the hierarchy.
     */
    forwardNativeEvent(ev: ReolinkSimpleEvent): void {
        const logger = this.getBaichuanLogger();
        const eventChannel = ev?.channel;

        // First, forward event to the MultiFocal device itself
        try {
            this.onSimpleEvent(ev);
        } catch (e) {
            logger.warn(`Error forwarding event to MultiFocal device itself:`, e?.message || String(e));
        }

        // Then, forward event to all lens devices (camera children) of this MultiFocal
        // Even if event has a specific channel, we forward to all lenses because:
        // 1. On NVR, wide and tele lenses can share the same channel
        // 2. Events might be relevant to all lenses of the MultiFocal device
        const lensDevices = Array.from(this.cameraNativeMap.values());
        const forwardedCount = lensDevices.length;
        
        if (forwardedCount === 0) {
            logger.debug(`No lens devices found for MultiFocal, event forwarded only to MultiFocal itself`);
            return;
        }

        logger.debug(`Forwarding event (channel=${eventChannel}) to MultiFocal itself and ${forwardedCount} lens device(s)`);

        // Forward event to all camera children (lens devices)
        for (const camera of lensDevices) {
            try {
                // Each lens device will filter events based on its own channel if needed
                camera.onSimpleEvent(ev);
            } catch (e) {
                logger.warn(`Error forwarding event to lens device ${camera.nativeId}:`, e?.message || String(e));
            }
        }
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

