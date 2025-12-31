import sdk, { DeviceCreator, DeviceCreatorSettings, DeviceInformation, DeviceProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting } from "@scrypted/sdk";
import { ReolinkNativeCamera } from "./camera";
import { connectBaichuanWithTcpUdpFallback, maskUid } from "./connect";
import { getDeviceInterfaces } from "./utils";

class ReolinkNativePlugin extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
    devices = new Map<string, ReolinkNativeCamera>();

    getScryptedDeviceCreator(): string {
        return 'Reolink Native camera';
    }

    async getDevice(nativeId: ScryptedNativeId): Promise<ReolinkNativeCamera> {
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

        if (ipAddress && username && password) {
            const { api } = await connectBaichuanWithTcpUdpFallback(
                {
                    host: ipAddress,
                    username,
                    password,
                    uid,
                    logger: this.console,
                },
                ({ uid: normalizedUid, uidMissing }) => {
                    const uidMsg = !uidMissing && normalizedUid ? `UID ${maskUid(normalizedUid)}` : 'UID MISSING';
                    this.console.log(
                        `Baichuan TCP failed during discovery for ${ipAddress}; falling back to UDP/BCUDP (${uidMsg}).`,
                    );
                },
            );

            try {
                const deviceInfo = await api.getInfo();
                const name = deviceInfo?.name;
                const rtspChannel = 0;
                const { abilities, capabilities } = await api.getDeviceCapabilities(rtspChannel);

                this.console.log(JSON.stringify({ abilities, capabilities, deviceInfo }));

                nativeId = deviceInfo.serialNumber;
                const type = capabilities.isDoorbell ? ScryptedDeviceType.DataSource : ScryptedDeviceType.Camera;

                settings.newCamera ||= name;

                const interfaces = getDeviceInterfaces({
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

                const device = await this.getDevice(nativeId) as ReolinkNativeCamera;
                device.info = info;
                device.storageSettings.values.username = username;
                device.storageSettings.values.password = password;
                device.storageSettings.values.rtspChannel = rtspChannel;
                device.storageSettings.values.ipAddress = ipAddress;
                if (uid) device.storageSettings.values.uid = uid;
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
        return new ReolinkNativeCamera(nativeId, this);
    }
}

export default ReolinkNativePlugin;
