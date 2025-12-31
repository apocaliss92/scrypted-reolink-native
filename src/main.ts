import sdk, { DeviceCreator, DeviceCreatorSettings, DeviceInformation, DeviceProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedNativeId, Setting } from "@scrypted/sdk";
import { ReolinkNativeCamera } from "./camera";
import { ReolinkNativeBatteryCamera } from "./camera-battery";
import { createBaichuanApi } from "./connect";
import { getDeviceInterfaces } from "./utils";

class ReolinkNativePlugin extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
    devices = new Map<string, ReolinkNativeCamera | ReolinkNativeBatteryCamera>();

    getScryptedDeviceCreator(): string {
        return 'Reolink Native camera';
    }

    async getDevice(nativeId: ScryptedNativeId): Promise<ReolinkNativeCamera | ReolinkNativeBatteryCamera> {
        if (this.devices.has(nativeId)) {
            return this.devices.get(nativeId);
        }

        const newCamera = this.createCamera(nativeId);
        this.devices.set(nativeId, newCamera);
        return newCamera;
    }

    async createDevice(settings: DeviceCreatorSettings, nativeId?: string): Promise<string> {
        const ipAddress = settings.ip?.toString();
        let info: DeviceInformation = {};

        const username = settings.username?.toString();
        const password = settings.password?.toString();
        const uid = settings.uid?.toString();
        const isBatteryCam = settings.isBatteryCam === true || settings.isBatteryCam?.toString() === 'true';

        if (isBatteryCam && !uid) {
            throw new Error('UID is required for battery cameras (BCUDP)');
        }

        if (ipAddress && username && password) {
            const api = await createBaichuanApi(
                {
                    host: ipAddress,
                    username,
                    password,
                    uid,
                    logger: this.console,
                },
                isBatteryCam ? 'udp' : 'tcp',
            );

            await api.login();

            try {
                const deviceInfo = await api.getInfo();
                const name = deviceInfo?.name;
                const rtspChannel = 0;
                const { abilities, capabilities } = await api.getDeviceCapabilities(rtspChannel, { probeAi: false });

                this.console.log(JSON.stringify({ abilities, capabilities, deviceInfo }));

                nativeId = `${deviceInfo.serialNumber}${isBatteryCam ? '-battery-cam' : '-cam'}`;

                settings.newCamera ||= name;

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
                device.info = info;
                device.storageSettings.values.username = username;
                device.storageSettings.values.password = password;
                device.storageSettings.values.rtspChannel = rtspChannel;
                device.storageSettings.values.ipAddress = ipAddress;
                if (isBatteryCam && uid) (device as ReolinkNativeBatteryCamera).storageSettings.values.uid = uid;
                device.storageSettings.values.capabilities = capabilities;
                device.updateDeviceInfo();

                return nativeId;
            }
            catch (e) {
                this.console.error('Error adding Reolink camera', e);
                await api.close();
                throw e;
            }
            finally {
                await api.close();
            }
        }
    }

    async releaseDevice(id: string, nativeId: ScryptedNativeId): Promise<void> {
        if (this.devices.has(nativeId)) {
            const device = this.devices.get(nativeId);
            await device.release();
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
                key: 'isBatteryCam',
                title: 'Is Battery Camera',
                description: 'Enable for Reolink battery cameras. Uses UDP/BCUDP for discovery and streaming. Requires UID.',
                type: 'boolean',
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
                description: 'Reolink UID (required for battery cameras)',
            }
        ]
    }

    createCamera(nativeId: string) {
        if (nativeId.endsWith('-battery-cam')) {
            return new ReolinkNativeBatteryCamera(nativeId, this);
        }
        return new ReolinkNativeCamera(nativeId, this);
    }
}

export default ReolinkNativePlugin;
