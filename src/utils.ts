import type { DeviceCapabilities, ReolinkDeviceInfo } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { Device, DeviceBase, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface } from "@scrypted/sdk";

/**
 * Enumeration of operation types that may require specific channel assignments
 */
export enum OperationChannelType {
    PAN = 'pan',
    TILT = 'tilt',
    ZOOM = 'zoom',
    INTERCOM = 'intercom',
    GOTO = 'goto',
    PRESET = 'preset',
    PATROL = 'patrol',
    TRACK = 'track',
}

/**
 * Type for channel-specific operation mappings
 */
export type OperationChannelMap = Partial<Record<OperationChannelType, number>>;

export const nvrSuffix = `-nvr`;
export const batteryCameraSuffix = `-battery-cam`;
export const multifocalSuffix = `-multifocal`;
export const batteryMultifocalSuffix = `-battery-multifocal`;
export const cameraSuffix = `-cam`;
export const sirenSuffix = `-siren`;
export const floodlightSuffix = `-floodlight`;
export const pirSuffix = `-pir`;

export const getDeviceInterfaces = (props: {
    capabilities: DeviceCapabilities,
    logger: Console
}) => {
    const { capabilities, logger } = props;

    const interfaces = [
        ScryptedInterface.VideoCamera,
        ScryptedInterface.Settings,
        ScryptedInterface.Reboot,
        ScryptedInterface.VideoCameraConfiguration,
        ScryptedInterface.Camera,
        ScryptedInterface.AudioSensor,
        ScryptedInterface.MotionSensor,
        ScryptedInterface.VideoTextOverlays,
    ];

    try {
        const {
            hasPtz,
            hasSiren,
            hasFloodlight,
            hasPir,
            hasBattery,
            hasIntercom,
            isDoorbell,
        } = capabilities;

        if (hasPtz) {
            interfaces.push(ScryptedInterface.PanTiltZoom);
        }
        interfaces.push(ScryptedInterface.ObjectDetector);
        if (hasSiren || hasFloodlight || hasPir)
            interfaces.push(ScryptedInterface.DeviceProvider);
        if (hasBattery) {
            interfaces.push(ScryptedInterface.Battery, ScryptedInterface.Sleep);
        }
        if (hasIntercom) {
            interfaces.push(ScryptedInterface.Intercom);
        }
        if (isDoorbell) {
            interfaces.push(ScryptedInterface.BinarySensor);
        }
    } catch (e) {
        logger.error('Error getting device interfaces', e);
    }

    return { interfaces, type: capabilities.isDoorbell ? ScryptedDeviceType.Doorbell : ScryptedDeviceType.Camera };
}

export const updateDeviceInfo = async (props: {
    device: DeviceBase,
    ipAddress: string,
    deviceData: ReolinkDeviceInfo,
    logger: Console
}) => {
    const { device, ipAddress, deviceData, logger } = props;
    try {
        const info = device.info || {};

        info.ip = ipAddress;
        info.serialNumber = deviceData?.serialNumber || deviceData?.itemNo;
        info.firmware = deviceData?.firmwareVersion;
        info.version = deviceData?.hardwareVersion;
        info.model = deviceData?.type;
        info.manufacturer = 'Reolink';
        info.managementUrl = `http://${ipAddress}`;
        device.info = info;
    } catch (e) {
        // If API call fails, at least set basic info
        const info = device.info || {};
        info.ip = ipAddress;
        info.manufacturer = 'Reolink native';
        info.managementUrl = `http://${ipAddress}`;
        device.info = info;

        throw e;
    } finally {

        logger.log(`Device info updated`);
        logger.debug(`${JSON.stringify({ newInfo: device.info, deviceData })}`);
    }
}