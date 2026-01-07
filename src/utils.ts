import type { DeviceCapabilities, EnrichedRecordingFile, RecordingFile, ReolinkBaichuanApi, ReolinkDeviceInfo } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { DeviceBase, HttpRequest, HttpResponse, MediaObject, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, VideoClip, VideoClips } from "@scrypted/sdk";
import { spawn } from "node:child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { CommonCameraMixin } from "./common";

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
        /** Plugin instance for generating webhook URLs */
        plugin?: ScryptedDeviceBase;
        /** Device ID for webhook URLs */
        deviceId?: string;
        /** Use webhook URLs instead of direct RTMP URLs */
        useWebhook?: boolean;
    }
): Promise<VideoClip> {
    const { fallbackStart, api, videoHref: providedVideoHref, logger, plugin, deviceId, useWebhook } = options;

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
    let thumbnailHref: string | undefined;

    // If webhook is enabled, generate webhook URLs
    if (useWebhook && plugin && deviceId) {
        try {
            const { videoUrl, thumbnailUrl } = await getVideoClipWebhookUrls({
                deviceId,
                fileId: id,
                plugin,
            });
            videoHref = videoUrl;
            thumbnailHref = thumbnailUrl;
        } catch (e) {
            logger?.error('recordingFileToVideoClip: failed to generate webhook URLs', e);
        }
    } else if (!videoHref && api) {
        // Fallback to direct RTMP URL if webhook is not used
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
        resources: videoHref || thumbnailHref
            ? {
                ...(videoHref ? { video: { href: videoHref } } : {}),
                ...(thumbnailHref ? { thumbnail: { href: thumbnailHref } } : {}),
            }
            : undefined,
    };
}

/**
 * Generate webhook URLs for video clips
 */
export async function getVideoClipWebhookUrls(props: {
    deviceId: string;
    fileId: string;
    plugin: ScryptedDeviceBase;
}): Promise<{ videoUrl: string; thumbnailUrl: string }> {
    const { deviceId, fileId, plugin } = props;

    try {
        let endpoint: string;
        try {
            endpoint = await sdk.endpointManager.getCloudEndpoint(undefined, { public: true });
        } catch (e) {
            // Fallback to local endpoint if cloud is not available (e.g., not logged in)
            // plugin.console.debug('Cloud endpoint not available, using local endpoint', e);
            endpoint = await sdk.endpointManager.getLocalEndpoint(undefined, { public: true });
        }

        const encodedDeviceId = encodeURIComponent(deviceId);
        // Remove leading slash from fileId if present, as it causes invalid paths when encoded
        const cleanFileId = fileId.startsWith('/') ? fileId.substring(1) : fileId;
        const encodedFileId = encodeURIComponent(cleanFileId);

        // Ensure endpoint has trailing slash
        const normalizedEndpoint = endpoint.endsWith('/') ? endpoint : `${endpoint}/`;

        const videoUrl = `${normalizedEndpoint}webhook/video/${encodedDeviceId}/${encodedFileId}`;
        const thumbnailUrl = `${normalizedEndpoint}webhook/thumbnail/${encodedDeviceId}/${encodedFileId}`;

        return { videoUrl, thumbnailUrl };
    } catch (e) {
        plugin.console.error('Failed to generate webhook URLs', e);
        throw e;
    }
}

/**
 * Extract a thumbnail frame from video using ffmpeg
 */
export async function extractThumbnailFromVideo(props: {
    rtmpUrl: string;
    fileId: string;
    deviceId: string;
    logger: Console;
}): Promise<MediaObject> {
    const { rtmpUrl, fileId, deviceId, logger } = props;

    try {
        // Get ffmpeg path
        const ffmpegPath = await sdk.mediaManager.getFFmpegPath();

        // Build ffmpeg args to extract a frame at 2 seconds
        const ffmpegArgs = [
            '-ss', '2', // Seek to 2 seconds
            '-i', rtmpUrl,
            '-vframes', '1', // Extract only 1 frame
            '-q:v', '2', // High quality JPEG
            '-f', 'image2', // Output format
            'pipe:1', // Output to stdout
        ];

        return new Promise<MediaObject>((resolve, reject) => {
            const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            const chunks: Buffer[] = [];
            let errorOutput = '';

            ffmpeg.stdout.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
            });

            ffmpeg.stderr.on('data', (chunk: Buffer) => {
                errorOutput += chunk.toString();
            });

            let resolved = false;

            ffmpeg.on('close', async (code) => {
                if (resolved) return;
                resolved = true;

                if (code !== 0) {
                    logger.error(`[Thumbnail] Error: fileId=${fileId}`, new Error(`ffmpeg failed with code ${code}: ${errorOutput}`));
                    reject(new Error(`ffmpeg failed with code ${code}: ${errorOutput}`));
                    return;
                }

                try {
                    const imageBuffer = Buffer.concat(chunks);
                    if (imageBuffer.length === 0) {
                        logger.error(`[Thumbnail] Error: fileId=${fileId}`, new Error('No image data received from ffmpeg'));
                        reject(new Error('No image data received from ffmpeg'));
                        return;
                    }

                    const mo = await sdk.mediaManager.createMediaObject(imageBuffer, 'image/jpeg');
                    logger.log(`[Thumbnail] Completed: fileId=${fileId}, size=${imageBuffer.length} bytes`);
                    resolve(mo);
                } catch (e) {
                    logger.error(`[Thumbnail] Error: fileId=${fileId}`, e);
                    reject(e);
                }
            });

            ffmpeg.on('error', (error) => {
                if (resolved) return;
                resolved = true;
                logger.error(`[Thumbnail] Error: fileId=${fileId}`, error);
                reject(error);
            });

            // Timeout after 30 seconds
            const timeout = setTimeout(() => {
                if (resolved) return;
                resolved = true;
                try {
                    ffmpeg.kill('SIGKILL');
                } catch (e) {
                    // Ignore
                }
                reject(new Error('Thumbnail extraction timeout'));
            }, 30000);

            ffmpeg.on('close', () => {
                clearTimeout(timeout);
            });
        });
    } catch (e) {
        logger.error(`[Thumbnail] Error: fileId=${fileId}`, e);
        throw e;
    }
}

/**
 * Get cache file path for a video clip
 */
function getVideoClipCachePath(deviceId: string, fileId: string): string {
    const pluginVolume = process.env.SCRYPTED_PLUGIN_VOLUME || '';
    // Create a safe filename from fileId using hash
    const hash = crypto.createHash('md5').update(fileId).digest('hex');
    // Keep original extension if present, otherwise use .mp4
    const ext = fileId.includes('.') ? path.extname(fileId) : '.mp4';
    const cacheDir = path.join(pluginVolume, 'snapshots', deviceId);
    return path.join(cacheDir, `${hash}${ext}`);
}

/**
 * Handle video clip webhook request
 * Checks cache first, then proxies RTMP stream if not cached
 */
export async function handleVideoClipRequest(props: {
    device: CommonCameraMixin;
    deviceId: string;
    fileId: string;
    request: HttpRequest;
    response: HttpResponse;
    logger: Console;
}): Promise<void> {
    const { device, deviceId, fileId, request, response, logger } = props;

    // Check if file is cached
    const cachePath = getVideoClipCachePath(deviceId, fileId);

    try {
        // Check if cached file exists
        const stat = await fs.promises.stat(cachePath);
        const fileSize = stat.size;
        const range = request.headers.range;

        logger.log(`Serving cached video clip: fileId=${fileId}, size=${fileSize}, range=${range}`);

        if (range) {
            // Parse range header
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(cachePath, { start, end });

            // Send stream with range support
            response.sendStream((async function* () {
                for await (const chunk of file) {
                    yield chunk;
                }
            })(), {
                code: 206,
                headers: {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunksize.toString(),
                    'Content-Type': 'video/mp4',
                }
            });
            return;
        } else {
            // No range header, send full file
            response.sendFile(cachePath, {
                code: 200,
                headers: {
                    'Content-Length': fileSize.toString(),
                    'Content-Type': 'video/mp4',
                    'Accept-Ranges': 'bytes',
                }
            });
            return;
        }
    } catch (e) {
        // File not cached, need to proxy RTMP stream
        logger.log(`Cache miss, proxying RTMP stream: fileId=${fileId}`);

        // Get RTMP URL directly from API using fileId
        // Cast device to CommonCameraMixin to access API
        let rtmpVodUrl: string | undefined;
        try {
            const api = await device.ensureClient();
            const result = await api.getRecordingPlaybackUrls({
                fileName: fileId,
            });
            rtmpVodUrl = result.rtmpVodUrl;
        } catch (e2) {
            logger.error(`Failed to get RTMP URL from API: fileId=${fileId}`, e2);
            response.send('Failed to get RTMP playback URL', { code: 500 });
            return;
        }

        if (!rtmpVodUrl) {
            logger.error(`No RTMP URL found for video: fileId=${fileId}`);
            response.send('No RTMP playback URL found for video', { code: 404 });
            return;
        }

        // logger.log(`Got RTMP URL for proxy: fileId=${fileId}`);

        // Use ffmpeg to proxy the RTMP stream
        const ffmpegPath = await sdk.mediaManager.getFFmpegPath();
        const ffmpegArgs: string[] = [
            '-i', rtmpVodUrl,
            '-c', 'copy', // Copy codecs without re-encoding
            '-f', 'mp4',
            '-movflags', 'frag_keyframe+empty_moov', // Enable streaming
            'pipe:1', // Output to stdout
        ];

        const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let ffmpegError = '';
        ffmpeg.stderr.on('data', (chunk: Buffer) => {
            ffmpegError += chunk.toString();
        });

        let streamStarted = false;

        // Stream the output
        response.sendStream((async function* () {
            try {
                for await (const chunk of ffmpeg.stdout) {
                    if (!streamStarted) {
                        streamStarted = true;
                    }
                    yield chunk;
                }
            } catch (e) {
                logger.error(`Error streaming video: fileId=${fileId}`, e);
                throw e;
            } finally {
                // Clean up ffmpeg process
                try {
                    ffmpeg.kill('SIGKILL');
                } catch (e) {
                    // Ignore
                }
            }
        })(), {
            code: 200,
            headers: {
                'Content-Type': 'video/mp4',
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache',
            },
        });

        // Handle ffmpeg errors
        ffmpeg.on('close', (code) => {
            if (code !== 0 && code !== null && !streamStarted) {
                logger.error(`FFmpeg proxy failed for video: fileId=${fileId}, code=${code}, error=${ffmpegError}`);
            }
        });

        ffmpeg.on('error', (error) => {
            logger.error(`FFmpeg spawn error for video proxy: fileId=${fileId}`, error);
        });

        return;
    }
}