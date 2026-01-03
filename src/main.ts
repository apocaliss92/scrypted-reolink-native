import sdk, { DeviceCreator, DeviceCreatorSettings, DeviceInformation, DeviceProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting } from "@scrypted/sdk";
import { ReolinkNativeCamera } from "./camera";
import { ReolinkNativeBatteryCamera } from "./camera-battery";
import { ReolinkNativeNvrDevice } from "./nvr";
import { autoDetectDeviceType, createBaichuanApi } from "./connect";
import { getDeviceInterfaces } from "./utils";

class ReolinkNativePlugin extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
    devices = new Map<string, ReolinkNativeCamera | ReolinkNativeBatteryCamera | ReolinkNativeNvrDevice>();

    getScryptedDeviceCreator(): string {
        return 'Reolink Native camera';
    }

    async getDevice(nativeId: ScryptedNativeId): Promise<ReolinkNativeCamera | ReolinkNativeBatteryCamera | ReolinkNativeNvrDevice> {
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
        const detection = await autoDetectDeviceType(
            {
                host: ipAddress,
                username,
                password,
                uid,
                logger: this.console,
            },
            this.console
        );

        this.console.log(`[AutoDetect] Detected device type: ${detection.type} (transport: ${detection.transport})`);

        // Handle NVR case
        if (detection.type === 'nvr') {
            const deviceInfo = detection.deviceInfo || {};
            const name = deviceInfo?.name || 'Reolink NVR';
            const serialNumber = deviceInfo?.serialNumber || deviceInfo?.itemNo || `nvr-${Date.now()}`;
            nativeId = `${serialNumber}-nvr`;

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
                type: ScryptedDeviceType.Builtin,
                providerNativeId: this.nativeId,
            });

            const device = await this.getDevice(nativeId);
            if (!(device instanceof ReolinkNativeNvrDevice)) {
                throw new Error('Expected NVR device but got different type');
            }
            device.storageSettings.values.ipAddress = ipAddress;
            device.storageSettings.values.username = username;
            device.storageSettings.values.password = password;
            device.updateDeviceInfo(deviceInfo);

            return nativeId;
        }

        // For camera and battery-cam, create the device
        const deviceInfo = detection.deviceInfo || {};
        const name = deviceInfo?.name || 'Reolink Camera';
        const serialNumber = deviceInfo?.serialNumber || deviceInfo?.itemNo || `unknown-${Date.now()}`;

        // Create nativeId based on device type
        if (detection.type === 'battery-cam') {
            nativeId = `${serialNumber}-battery-cam`;
        } else {
            nativeId = `${serialNumber}-cam`;
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

            const device = await this.getDevice(nativeId);
            if (device instanceof ReolinkNativeNvrDevice) {
                // NVR devices are handled separately above
                throw new Error('NVR device should not reach this code path');
            }

            // Type guard: device is either ReolinkNativeCamera or ReolinkNativeBatteryCamera
            device.info = deviceInfo;
            device.classes = objects;
            device.presets = presets;
            device.storageSettings.values.username = username;
            device.storageSettings.values.password = password;
            device.storageSettings.values.rtspChannel = rtspChannel;
            device.storageSettings.values.ipAddress = ipAddress;
            device.storageSettings.values.capabilities = capabilities;
            device.storageSettings.values.uid = detection.uid;
            device.updateDeviceInfo();

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
        if (nativeId.endsWith('-battery-cam')) {
            return new ReolinkNativeBatteryCamera(nativeId, this);
        } else if (nativeId.endsWith('-nvr')) {
            return new ReolinkNativeNvrDevice(nativeId, this);
        } else {
            return new ReolinkNativeCamera(nativeId, this);
        }
    }
}

export default ReolinkNativePlugin;
