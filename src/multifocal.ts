import type { BatteryInfo, DeviceCapabilities, DualLensChannelAnalysis, NativeVideoStreamVariant, ReolinkBaichuanApi, ReolinkSimpleEvent, SleepStatus } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { Device, DeviceProvider, Reboot, ScryptedDeviceType, Settings } from "@scrypted/sdk";
import type { BaichuanConnectionConfig } from "./baichuan-base";
import { CameraType, ReolinkCamera } from "./camera";
import ReolinkNativePlugin from "./main";
import { ReolinkNativeNvrDevice } from "./nvr";
import { batteryCameraSuffix, cameraSuffix, getDeviceInterfaces } from "./utils";

export class ReolinkNativeMultiFocalDevice extends ReolinkCamera implements Settings, DeviceProvider, Reboot {
    plugin: ReolinkNativePlugin;
    lensDevicesMap = new Map<string, ReolinkCamera>();
    private channelToNativeIdMap = new Map<number, string>();

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
            isLensDevice: !!lensType
        });

        logger.debug(`Interfaces found for lens ${lensType}: ${JSON.stringify({ interfaces, capabilities, multifocalInfo, isLensDevice: !!lensType })}`);

        return { interfaces, capabilities };
    }

    async reportDevices(): Promise<void> {
        await super.reportDevices();

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
            let device = this.lensDevicesMap.get(nativeId);
            if (!device) {
                if (nativeId.endsWith(batteryCameraSuffix)) {
                    device = new ReolinkCamera(nativeId, this.plugin, { type: 'battery', multiFocalDevice: this });
                } else {
                    device = new ReolinkCamera(nativeId, this.plugin, { type: 'regular', multiFocalDevice: this });
                }
            }

            if (device) {
                this.lensDevicesMap.set(nativeId, device);
            }

            return device;
        } else {
            return super.getDevice(nativeId);
        }
    }

    async releaseDevice(id: string, nativeId: string) {
        this.lensDevicesMap.delete(nativeId);
        super.releaseDevice(id, nativeId);
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

            const outputPath = this.storageSettings.values.diagnosticsOutputPath || process.env.SCRYPTED_PLUGIN_VOLUME || "";
            if (!outputPath) {
                throw new Error('Diagnostics output path is required');
            }

            const api = await this.ensureClient();

            const channel = this.storageSettings.values.rtspChannel || 0;
            const durationSeconds = 8;
            const result = await api.runMultifocalDiagnosticsConsecutively({
                logger,
                outDir: outputPath,
                channel,
                durationSeconds,
                rtmpApps: ["bcs"],
                probeFull: true,
                onNvr: !!this.nvrDevice,
            });

            logger.log(`Multifocal diagnostics completed successfully. Output directory: ${result.runDir}`);
            logger.log(`Results file: ${result.resultsPath}`);
            logger.log(`Streams directory: ${result.streamsDir}`);
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
        const { ipAddress, username, password, uid, discoveryMethod } = this.storageSettings.values;
        const debugOptions = this.getBaichuanDebugOptions();

        // Multifocal battery cams use BCUDP for streaming too; UID is required.
        const normalizedUid = this.isBattery ? uid?.trim() || undefined : undefined;
        if (this.isBattery && !normalizedUid) {
            throw new Error('UID is required for battery cameras (BCUDP)');
        }

        return {
            host: ipAddress,
            username,
            password,
            uid: normalizedUid,
            transport: this.transport,
            debugOptions,
            udpDiscoveryMethod: discoveryMethod,
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

        // For multifocal battery cams (BCUDP), reuse the main client to avoid D2C_DISC storms.
        if (this.isBattery) {
            // For battery (BCUDP) cameras, streaming must be keyed by streamKey.
            // Do NOT reuse ensureClient(): composite needs two concurrent streams, and single-lens streams
            // should reuse the same API that composite already created for that same streamKey.
            return await super.createStreamClient(streamKey);
        }

        // Otherwise, use base class createStreamClient which manages stream clients per streamKey
        return await super.createStreamClient(streamKey);
    }

    getLensDevices() {
        const devices = Array.from(this.lensDevicesMap.values());
        // const logger = this.getBaichuanLogger();
        // logger.debug(`Found ${devices.length} lens devices: ${devices.map(d => d.nativeId).join(', ')}`);

        return devices;
    }

    async updateBatteryInfo() {
        const batteryInfo = await super.updateBatteryInfo();
        const lensDevices = this.getLensDevices();

        for (const camera of lensDevices) {
            await camera.updateBatteryInfo(batteryInfo);
        }

        return batteryInfo;
    }

    onSimpleEvent(ev: ReolinkSimpleEvent) {
        super.onSimpleEvent(ev);
        const logger = this.getBaichuanLogger();
        const lensDevices = this.getLensDevices();

        for (const camera of lensDevices) {
            logger.debug(`Forward ${ev.type} event to lens device ${camera.nativeId}`);
            camera.onSimpleEvent(ev);
        }
    }

    async updateSleepingState(sleepStatus: SleepStatus) {
        const logger = this.getBaichuanLogger();
        await super.updateSleepingState(sleepStatus);
        const lensDevices = this.getLensDevices();

        for (const camera of lensDevices) {
            logger.debug(`Forward ${JSON.stringify(sleepStatus)} sleeping state to lens device ${camera.nativeId}`);
            await camera.updateSleepingState(sleepStatus);
        }
    }

    async updateOnlineState(isOnline: boolean) {
        const logger = this.getBaichuanLogger();
        await super.updateOnlineState(isOnline);
        const lensDevices = this.getLensDevices();

        for (const camera of lensDevices) {
            logger.debug(`Forward ${isOnline ? 'online' : 'offline'} state to lens device ${camera.nativeId}`);
            await camera.updateOnlineState(isOnline);
        }
    }
}

