import type { DeviceCapabilities, ReolinkDeviceInfo, RecordingFile, EnrichedRecordingFile, ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { Device, DeviceBase, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, VideoClip } from "@scrypted/sdk";

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
        ScryptedInterface.VideoClips,
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

/**
 * Convert a Reolink RecordingFile or EnrichedRecordingFile to a Scrypted VideoClip
 */
export async function recordingFileToVideoClip(
    rec: RecordingFile | EnrichedRecordingFile,
    options: {
        /** Fallback start date if recording doesn't have one */
        fallbackStart: Date;
        /** API instance to get playback URLs (optional, can provide videoHref directly) */
        api?: ReolinkBaichuanApi;
        /** Pre-fetched video URL (optional, will fetch if not provided and api is available) */
        videoHref?: string;
        /** Logger for debug messages */
        logger?: Console;
    }
): Promise<VideoClip> {
    const { fallbackStart, api, videoHref: providedVideoHref, logger } = options;

    // Handle both RecordingFile (has startTime/endTime as Date) and EnrichedRecordingFile (has startTimeMs/endTimeMs as number)
    let recStart: Date;
    let recEnd: Date;
    
    if ('startTime' in rec && rec.startTime instanceof Date) {
        recStart = rec.startTime;
    } else if ('startTimeMs' in rec && typeof rec.startTimeMs === 'number') {
        recStart = new Date(rec.startTimeMs);
    } else {
        recStart = rec.parsedFileName?.start ?? fallbackStart;
    }
    
    if ('endTime' in rec && rec.endTime instanceof Date) {
        recEnd = rec.endTime;
    } else if ('endTimeMs' in rec && typeof rec.endTimeMs === 'number') {
        recEnd = new Date(rec.endTimeMs);
    } else {
        recEnd = rec.parsedFileName?.end ?? recStart;
    }

    const recStartMs = recStart.getTime();
    const recEndMs = Math.max(recEnd.getTime(), recStartMs);
    const duration = recEndMs - recStartMs;

    const id = rec.id || rec.fileName;

    // Get video URL if not provided
    let videoHref: string | undefined = providedVideoHref;
    if (!videoHref && api) {
        try {
            const { rtmpVodUrl } = await api.getRecordingPlaybackUrls({
                fileName: rec.fileName,
            });
            videoHref = rtmpVodUrl;
        } catch (e) {
            logger?.debug('recordingFileToVideoClip: failed to build playback URL for recording', rec.fileName, e);
        }
    }

    const description = ('name' in rec && typeof rec.name === 'string' && rec.name) ? rec.name : (rec.fileName ?? rec.id ?? '');

    // Build detectionClasses from flags or recordType
    const detectionClasses: string[] = ['Motion'];
    
    // Check for EnrichedRecordingFile flags
    if ('hasPerson' in rec && rec.hasPerson) {
        detectionClasses.push('Person');
    }
    if ('hasVehicle' in rec && rec.hasVehicle) {
        detectionClasses.push('Vehicle');
    }
    if ('hasAnimal' in rec && rec.hasAnimal) {
        detectionClasses.push('Animal');
    }
    if ('hasFace' in rec && rec.hasFace) {
        detectionClasses.push('Face');
    }
    if ('hasDoorbell' in rec && rec.hasDoorbell) {
        detectionClasses.push('Doorbell');
    }
    if ('hasPackage' in rec && rec.hasPackage) {
        detectionClasses.push('Package');
    }
    
    // Fallback: parse recordType string if flags are not available
    if (detectionClasses.length === 0 && rec.recordType) {
        const recordTypeLower = rec.recordType.toLowerCase();
        if (recordTypeLower.includes('people') || recordTypeLower.includes('person')) {
            detectionClasses.push('Person');
        }
        if (recordTypeLower.includes('vehicle')) {
            detectionClasses.push('Vehicle');
        }
        if (recordTypeLower.includes('dog_cat') || recordTypeLower.includes('animal')) {
            detectionClasses.push('Animal');
        }
        if (recordTypeLower.includes('face')) {
            detectionClasses.push('Face');
        }
        if (recordTypeLower.includes('md') || recordTypeLower.includes('motion')) {
            detectionClasses.push('Motion');
        }
        if (recordTypeLower.includes('visitor') || recordTypeLower.includes('doorbell')) {
            detectionClasses.push('Doorbell');
        }
        if (recordTypeLower.includes('package')) {
            detectionClasses.push('Package');
        }
    }

    return {
        id,
        startTime: recStartMs,
        duration,
        event: rec.recordType,
        description,
        detectionClasses: detectionClasses.length > 0 ? detectionClasses : undefined,
        resources: videoHref
            ? {
                video: { href: videoHref },
            }
            : undefined,
    };
}