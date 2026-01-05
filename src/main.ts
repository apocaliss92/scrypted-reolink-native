import sdk, { DeviceCreator, DeviceCreatorSettings, DeviceProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting } from "@scrypted/sdk";
import { BaseBaichuanClass } from "./baichuan-base";
import { ReolinkNativeCamera } from "./camera";
import { ReolinkNativeBatteryCamera } from "./camera-battery";
import { CommonCameraMixin } from "./common";
import { createBaichuanApi } from "./connect";
import { ReolinkNativeMultiFocalDevice } from "./multifocal";
import { ReolinkNativeNvrDevice } from "./nvr";
import { batteryCameraSuffix, cameraSuffix, getDeviceInterfaces, multifocalSuffix, nvrSuffix } from "./utils";

class ReolinkNativePlugin extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
    devices = new Map<string, BaseBaichuanClass>();
    nvrDeviceId: string;

    constructor(nativeId: string) {
        super(nativeId);

        const nvrDevice = sdk.systemManager.getDeviceByName('Scrypted NVR');
        this.nvrDeviceId = nvrDevice?.id;
    }

    getScryptedDeviceCreator(): string {
        return 'Reolink Native camera';
    }

    async getDevice(nativeId: ScryptedNativeId): Promise<BaseBaichuanClass> {
        if (this.devices.has(nativeId)) {
            return this.devices.get(nativeId)!;
        }

        const newCamera = this.createCamera(nativeId);
        this.devices.set(nativeId, newCamera);
        return newCamera;
    }

    async createDevice(settings: DeviceCreatorSettings, nativeId?: string): Promise<string> {
        const ipAddress = settings.ip?.toString();
        const username = settings.username?.toString();
        const password = settings.password?.toString();
        const uid = settings.uid?.toString();

        if (!ipAddress || !username || !password) {
            throw new Error('IP address, username, and password are required');
        }

        // Auto-detect device type (camera, battery-cam, or nvr)
        this.console.log(`[AutoDetect] Starting device type detection for ${ipAddress}...`);
        const { autoDetectDeviceType } = await import("@apocaliss92/reolink-baichuan-js");

        const detection = await autoDetectDeviceType(
            {
                host: ipAddress,
                username,
                password,
                uid,
                logger: this.console,
            },
        );

        this.console.log(`[AutoDetect] Detected device type: ${detection.type} (transport: ${detection.transport})`);

        // Handle multi-focal device case
        if (detection.type === 'multifocal') {
            const deviceInfo = detection.deviceInfo || {};
            const name = deviceInfo.name || 'Reolink Multi-Focal';
            const serialNumber = deviceInfo.serialNumber || deviceInfo.itemNo || `multifocal-${Date.now()}`;
            nativeId = `${serialNumber}${multifocalSuffix}`;

            settings.newCamera ||= name;

            await sdk.deviceManager.onDeviceDiscovered({
                nativeId,
                name,
                interfaces: [
                    ScryptedInterface.Settings,
                    ScryptedInterface.DeviceDiscovery,
                    ScryptedInterface.DeviceProvider,
                    ScryptedInterface.Reboot,
                ],
                type: ScryptedDeviceType.DeviceProvider,
                providerNativeId: this.nativeId,
            });

            const device = await this.getDevice(nativeId);
            if (!(device instanceof ReolinkNativeMultiFocalDevice)) {
                throw new Error('Expected multi-focal device but got different type');
            }
            device.storageSettings.values.ipAddress = ipAddress;
            device.storageSettings.values.username = username;
            device.storageSettings.values.password = password;
            device.storageSettings.values.uid = detection.uid || '';

            return nativeId;
        }

        // Handle NVR case
        if (detection.type === 'nvr') {
            const deviceInfo = detection.deviceInfo || {};
            const name = deviceInfo?.name || 'Reolink NVR';
            const serialNumber = deviceInfo?.serialNumber || deviceInfo?.itemNo || `nvr-${Date.now()}`;
            nativeId = `${serialNumber}${nvrSuffix}`;

            settings.newCamera ||= name;

            await sdk.deviceManager.onDeviceDiscovered({
                nativeId,
                name,
                interfaces: [
                    ScryptedInterface.Settings,
                    ScryptedInterface.DeviceDiscovery,
                    ScryptedInterface.DeviceProvider,
                    ScryptedInterface.Reboot,
                ],
                type: ScryptedDeviceType.DeviceProvider,
                providerNativeId: this.nativeId,
            });

            const device = await this.getDevice(nativeId);
            if (!(device instanceof ReolinkNativeNvrDevice)) {
                throw new Error('Expected NVR device but got different type');
            }
            device.storageSettings.values.ipAddress = ipAddress;
            device.storageSettings.values.username = username;
            device.storageSettings.values.password = password;

            return nativeId;
        }

        // For camera and battery-cam, create the device
        const deviceInfo = detection.deviceInfo || {};
        const name = deviceInfo?.name || 'Reolink Camera';
        const serialNumber = deviceInfo?.serialNumber || deviceInfo?.itemNo || `unknown-${Date.now()}`;

        // Create nativeId based on device type
        if (detection.type === 'battery-cam') {
            nativeId = `${serialNumber}${batteryCameraSuffix}`;
        } else {
            nativeId = `${serialNumber}${cameraSuffix}`;
        }

        settings.newCamera ||= name;

        // Create API connection to get capabilities
        const api = await createBaichuanApi({
            inputs: {
                host: ipAddress,
                username,
                password,
                uid: detection.uid,
                logger: this.console,
            },
            transport: detection.transport,
            logger: this.console,
        });

        try {
            await api.login();
            const rtspChannel = 0;
            const { abilities, capabilities, objects, presets } = await api.getDeviceCapabilities(rtspChannel);

            this.console.log(JSON.stringify({ abilities, capabilities, deviceInfo }));

            const { interfaces, type } = getDeviceInterfaces({
                capabilities,
                logger: this.console,
            });

            await sdk.deviceManager.onDeviceDiscovered({
                nativeId,
                name,
                interfaces,
                type,
                providerNativeId: this.nativeId,
            });

            const device = await this.getDevice(nativeId) as CommonCameraMixin;

            device.info = deviceInfo;
            device.classes = objects;
            device.presets = presets;
            device.storageSettings.values.username = username;
            device.storageSettings.values.password = password;
            device.storageSettings.values.rtspChannel = rtspChannel;
            device.storageSettings.values.ipAddress = ipAddress;
            device.storageSettings.values.capabilities = capabilities;
            device.storageSettings.values.uid = detection.uid;

            return nativeId;
        }
        catch (e) {
            this.console.error('Error adding Reolink device', e);
            throw e;
        }
        finally {
            await api.close();
        }
    }

    async releaseDevice(id: string, nativeId: ScryptedNativeId): Promise<void> {
        if (this.devices.has(nativeId)) {
            const device = this.devices.get(nativeId);
            if (device && 'release' in device && typeof device.release === 'function') {
                await device.release();
            }
            this.devices.delete(nativeId);
        }
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [
            {
                key: 'ip',
                title: 'IP Address',
                placeholder: '192.168.2.222',
            },
            {
                key: 'username',
                title: 'Username',
            },
            {
                key: 'password',
                title: 'Password',
                type: 'password',
            },
            {
                key: 'uid',
                title: 'UID',
                description: 'Reolink UID (optional, required for battery cameras if TCP connection fails)',
            }
        ]
    }

    createCamera(nativeId: string) {
        if (nativeId.endsWith(batteryCameraSuffix)) {
            return new ReolinkNativeBatteryCamera(nativeId, this);
        } else if (nativeId.endsWith(nvrSuffix)) {
            return new ReolinkNativeNvrDevice(nativeId, this);
        } else if (nativeId.endsWith(multifocalSuffix)) {
            // Get transport from device settings if available, otherwise default to TCP
            // The transport is determined during autoDetect and should be stored
            // For now, we'll try to infer from UID presence (if UID is set, likely UDP)
            // Default to TCP for now - the transport will be set correctly during createDevice
            return new ReolinkNativeMultiFocalDevice(nativeId, this, 'tcp');
        } else {
            return new ReolinkNativeCamera(nativeId, this);
        }
    }
}

export default ReolinkNativePlugin;
