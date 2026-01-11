import type { DeviceCapabilities, EnrichedRecordingFile, NativeVideoStreamVariant, ParsedRecordingFileName, RecordingFile, ReolinkBaichuanApi, ReolinkDeviceInfo, VodFile, VodSearchResponse } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, { DeviceBase, HttpRequest, HttpResponse, MediaObject, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, VideoClip, VideoClips } from "@scrypted/sdk";
import { spawn } from "node:child_process";
import { Readable } from "stream";
import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ReolinkCamera } from "./camera";
/**
 * Sanitize FFmpeg output or URLs to avoid leaking credentials
 */
export function sanitizeFfmpegOutput(text: string): string {
    if (!text)
        return text;

    let sanitized = text;

    // Remove user/password query parameters from URLs: ?user=xxx&password=yyy
    sanitized = sanitized.replace(/(\buser=)[^&\s]*/gi, '$1***');
    sanitized = sanitized.replace(/(\bpassword=)[^&\s]*/gi, '$1***');

    // Remove credentials from URLs like rtmp://user:pass@host/...
    sanitized = sanitized.replace(/(rtmp:\/\/)([^:@\/\s]+):([^@\/\s]+)@/gi, '$1$2:***@');

    return sanitized;
}


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
    logger: Console,
    isLensDevice?: boolean
}) => {
    const { capabilities, logger, isLensDevice } = props;

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

    if (!isLensDevice) {
        interfaces.push(ScryptedInterface.VideoClips);
    }

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
        logger.error('Error getting device interfaces', e?.message || String(e));
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

    logger?.debug(`[recordingFileToVideoClip] URL generation: useWebhook=${useWebhook}, hasPlugin=${!!plugin}, deviceId=${deviceId}, providedVideoHref=${providedVideoHref || 'none'}, hasApi=${!!api}`);

    // If webhook is enabled, generate webhook URLs
    if (useWebhook && plugin && deviceId) {
        logger?.debug(`[recordingFileToVideoClip] Generating webhook URLs for fileId=${id}`);
        try {
            const { videoUrl, thumbnailUrl } = await getVideoClipWebhookUrls({
                deviceId,
                fileId: id,
                plugin,
                logger,
            });
            videoHref = videoUrl;
            thumbnailHref = thumbnailUrl;
            logger?.debug(`[recordingFileToVideoClip] Webhook URLs generated successfully: videoHref="${videoHref}", thumbnailHref="${thumbnailHref}"`);
        } catch (e) {
            logger?.error(`[recordingFileToVideoClip] Failed to generate webhook URLs for fileId=${id}:`, e?.message || String(e));
        }
    } else if (!videoHref && api) {
        // Fallback to direct RTMP URL if webhook is not used
        logger?.debug(`[recordingFileToVideoClip] Fetching RTMP playback URL for fileName=${rec.fileName}`);
        try {
            const { rtmpVodUrl } = await api.getRecordingPlaybackUrls({
                fileName: rec.fileName,
            });
            videoHref = rtmpVodUrl;
            logger?.debug(`[recordingFileToVideoClip] RTMP URL fetched successfully: videoHref="${videoHref}"`);
        } catch (e) {
            logger?.debug(`[recordingFileToVideoClip] Failed to build playback URL for recording fileName=${rec.fileName}:`, e?.message || String(e));
        }
    } else {
        logger?.debug(`[recordingFileToVideoClip] No URL generation: useWebhook=${useWebhook}, hasPlugin=${!!plugin}, deviceId=${deviceId}, providedVideoHref=${providedVideoHref || 'none'}, hasApi=${!!api}`);
    }

    const description = ('name' in rec && typeof rec.name === 'string' && rec.name) ? rec.name : (rec.fileName ?? rec.id ?? '');

    // Build detectionClasses from flags or recordType
    const detectionClasses: string[] = [];

    // Check for EnrichedRecordingFile flags first (most accurate)
    let hasAnyDetection = false;
    if ('hasPerson' in rec && rec.hasPerson) {
        detectionClasses.push('Person');
        hasAnyDetection = true;
    }
    if ('hasVehicle' in rec && rec.hasVehicle) {
        detectionClasses.push('Vehicle');
        hasAnyDetection = true;
    }
    if ('hasAnimal' in rec && rec.hasAnimal) {
        detectionClasses.push('Animal');
        hasAnyDetection = true;
    }
    if ('hasFace' in rec && rec.hasFace) {
        detectionClasses.push('Face');
        hasAnyDetection = true;
    }
    if ('hasMotion' in rec && rec.hasMotion) {
        detectionClasses.push('Motion');
        hasAnyDetection = true;
    }
    if ('hasDoorbell' in rec && rec.hasDoorbell) {
        detectionClasses.push('Doorbell');
        hasAnyDetection = true;
    }
    if ('hasPackage' in rec && rec.hasPackage) {
        detectionClasses.push('Package');
        hasAnyDetection = true;
    }

    // Log detection flags for debugging
    if (logger) {
        const flags = {
            hasPerson: 'hasPerson' in rec ? rec.hasPerson : undefined,
            hasVehicle: 'hasVehicle' in rec ? rec.hasVehicle : undefined,
            hasAnimal: 'hasAnimal' in rec ? rec.hasAnimal : undefined,
            hasFace: 'hasFace' in rec ? rec.hasFace : undefined,
            hasMotion: 'hasMotion' in rec ? rec.hasMotion : undefined,
            hasDoorbell: 'hasDoorbell' in rec ? rec.hasDoorbell : undefined,
            hasPackage: 'hasPackage' in rec ? rec.hasPackage : undefined,
            recordType: rec.recordType || 'none',
        };
    }

    // Fallback: parse recordType string if flags are not available
    if (!hasAnyDetection && rec.recordType) {
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

    // Always include Motion if no other detections found
    if (detectionClasses.length === 0) {
        detectionClasses.push('Motion');
    }

    const resources = videoHref || thumbnailHref
        ? {
            ...(videoHref ? { video: { href: videoHref } } : {}),
            ...(thumbnailHref ? { thumbnail: { href: thumbnailHref } } : {}),
        }
        : undefined;


    return {
        id,
        startTime: recStartMs,
        duration,
        event: rec.recordType,
        description,
        detectionClasses: detectionClasses.length > 0 ? detectionClasses : undefined,
        resources,
    };
}

/**
 * Convert an array of RecordingFile or EnrichedRecordingFile to VideoClip array
 * Uses recordingFileToVideoClip for each recording
 * Handles both NVR (EnrichedRecordingFile) and device standalone (RecordingFile) cases
 */
export async function recordingsToVideoClips(
    recordings: (RecordingFile | EnrichedRecordingFile)[],
    options: {
        /** Fallback start date if recording doesn't have one */
        fallbackStart: Date;
        /** API instance to get playback URLs (optional, for device standalone recordings) */
        api?: ReolinkBaichuanApi;
        /** Logger for debug messages */
        logger?: Console;
        /** Plugin instance for generating webhook URLs */
        plugin?: ScryptedDeviceBase;
        /** Device ID for webhook URLs */
        deviceId?: string;
        /** Use webhook URLs instead of direct RTMP URLs */
        useWebhook?: boolean;
        /** Maximum number of clips to return (optional) */
        count?: number;
    }
): Promise<VideoClip[]> {
    const { fallbackStart, api, logger, plugin, deviceId, useWebhook, count } = options;
    const clips: VideoClip[] = [];

    for (const rec of recordings) {
        try {
            const clip = await recordingFileToVideoClip(rec, {
                fallbackStart,
                api,
                logger,
                plugin,
                deviceId,
                useWebhook,
            });
            clips.push(clip);
        } catch (e) {
            logger?.warn(`Failed to convert recording to video clip: fileName=${rec.fileName}`, e?.message || String(e));
        }
    }

    // Apply count limit if specified
    return count ? clips.slice(0, count) : clips;
}

/**
 * Generate webhook URLs for video clips
 */
export async function getVideoClipWebhookUrls(props: {
    deviceId: string;
    fileId: string;
    plugin: ScryptedDeviceBase;
    logger?: Console;
}): Promise<{ videoUrl: string; thumbnailUrl: string }> {
    const { deviceId, fileId, plugin, logger } = props;
    const log = logger || plugin.console;

    // log.debug?.(`[getVideoClipWebhookUrls] Starting URL generation: deviceId=${deviceId}, fileId=${fileId}`);

    try {
        let endpoint: string;
        let endpointSource: 'cloud' | 'local';
        try {
            endpoint = await sdk.endpointManager.getCloudEndpoint(undefined, { public: true });
            endpointSource = 'cloud';
            // log.debug?.(`[getVideoClipWebhookUrls] Using cloud endpoint: ${endpoint}`);
        } catch (e) {
            // Fallback to local endpoint if cloud is not available (e.g., not logged in)
            log.debug?.(`[getVideoClipWebhookUrls] Cloud endpoint not available, using local endpoint: ${e?.message || String(e)}`);
            endpoint = await sdk.endpointManager.getLocalEndpoint(undefined, { public: true });
            endpointSource = 'local';
            // log.debug?.(`[getVideoClipWebhookUrls] Using local endpoint: ${endpoint}`);
        }

        const encodedDeviceId = encodeURIComponent(deviceId);
        // Remove leading slash from fileId if present, as it causes invalid paths when encoded
        const cleanFileId = fileId.startsWith('/') ? fileId.substring(1) : fileId;
        const encodedFileId = encodeURIComponent(cleanFileId);

        // Parse endpoint URL to extract query parameters (for authentication)
        const endpointUrl = new URL(endpoint);
        // Preserve query parameters (e.g., user_token for authentication)
        const queryParams = endpointUrl.search;
        // Remove query parameters from the base endpoint URL
        endpointUrl.search = '';

        // Ensure endpoint has trailing slash
        const normalizedEndpoint = endpointUrl.toString().endsWith('/') ? endpointUrl.toString() : `${endpointUrl.toString()}/`;

        // Build webhook URLs and append query parameters at the end
        const videoUrl = `${normalizedEndpoint}webhook/video/${encodedDeviceId}/${encodedFileId}${queryParams}`;
        const thumbnailUrl = `${normalizedEndpoint}webhook/thumbnail/${encodedDeviceId}/${encodedFileId}${queryParams}`;

        return { videoUrl, thumbnailUrl };
    } catch (e) {
        log.error?.(
            `[getVideoClipWebhookUrls] Failed to generate webhook URLs: deviceId=${deviceId}, fileId=${fileId}`,
            e?.message || String(e)
        );
        throw e;
    }
}

/**
 * Extract a thumbnail frame from video using ffmpeg
 */
export async function extractThumbnailFromVideo(props: {
    rtmpUrl?: string;
    filePath?: string;
    fileId: string;
    deviceId: string;
    logger?: Console;
    device?: ReolinkCamera;
}): Promise<MediaObject> {
    const { rtmpUrl, filePath, fileId, deviceId, device } = props;
    // Use device logger if available, otherwise fallback to provided logger
    const logger = device?.getBaichuanLogger?.() || props.logger || console;

    // Use file path if available, otherwise use RTMP URL
    const inputSource = filePath || rtmpUrl;
    if (!inputSource) {
        throw new Error('Either rtmpUrl or filePath must be provided');
    }

    try {
        // Use createFFmpegMediaObject which handles codec detection better
        // For Download URLs from NVR, they might return only a short segment, so use 1 second instead of 5
        const mo = await sdk.mediaManager.createFFmpegMediaObject({
            inputArguments: [
                '-ss', '00:00:01', // Seek to 1 second (safer for short segments from NVR Download URLs)
                '-i', inputSource,
            ],
        });
        return mo;
    } catch (e) {
        // Error already logged in main.ts
        throw e?.message || String(e);
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
    const cacheDir = path.join(pluginVolume, 'videoclips', deviceId);
    return path.join(cacheDir, `${hash}${ext}`);
}

/**
 * Handle video clip webhook request
 * Checks cache first, then proxies RTMP stream if not cached
 */
export async function handleVideoClipRequest(props: {
    device: ReolinkCamera;
    deviceId: string;
    fileId: string;
    request: HttpRequest;
    response: HttpResponse;
    logger?: Console;
}): Promise<void> {
    const { device, deviceId, fileId, request, response } = props;
    const logger = device.getBaichuanLogger?.() || props.logger || console;

    // Check if file is cached
    const cachePath = getVideoClipCachePath(deviceId, fileId);
    const MIN_VIDEO_CACHE_BYTES = 16 * 1024; // 16KB, evita file quasi vuoti/corrotti

    try {
        // Check if cached file exists
        const stat = await fs.promises.stat(cachePath);
        const fileSize = stat.size;
        const range = request.headers.range;

        if (fileSize < MIN_VIDEO_CACHE_BYTES) {
            logger.warn(`Cached video clip too small, deleting and reloading: fileId=${fileId}, size=${fileSize} bytes`);
            try {
                await fs.promises.unlink(cachePath);
            } catch (unlinkErr) {
                logger.warn(`Failed to delete small cached video clip: fileId=${fileId}`, unlinkErr?.message || String(unlinkErr));
            }
            // Force cache miss path below
            throw new Error('Cached video too small, deleted');
        }

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
        logger.log(`[VideoClip] Stream start: fileId=${fileId}`);

        // Get RTMP URL using the appropriate API (NVR or Baichuan)
        let rtmpVodUrl: string | undefined;
        try {
            rtmpVodUrl = await device.getVideoClipRtmpUrl(fileId);
        } catch (e2) {
            logger.error(`[VideoClip] Stream error: fileId=${fileId}`, e2?.message || String(e2));
            response.send('Failed to get RTMP playback URL', { code: 500 });
            return;
        }

        if (!rtmpVodUrl) {
            logger.error(`[VideoClip] Stream error: fileId=${fileId} - No URL found`);
            response.send('No RTMP playback URL found for video', { code: 404 });
            return;
        }

        // Check if URL is HTTP (Playback/Download) or RTMP
        const isHttpUrl = rtmpVodUrl.startsWith('http://') || rtmpVodUrl.startsWith('https://');

        if (isHttpUrl) {
            // For HTTP URLs (Playback/Download from NVR), do direct HTTP proxy with ranged headers support
            logger.debug(`Proxying HTTP URL directly: fileId=${fileId}, url=${rtmpVodUrl}`);

            const sendVideo = async () => {
                // Pre-fetch ffmpeg path in case we need it for FLV conversion
                const ffmpegPathPromise = sdk.mediaManager.getFFmpegPath();

                return new Promise<void>(async (resolve, reject) => {
                    const urlObj = new URL(rtmpVodUrl);
                    const httpModule = urlObj.protocol === 'https:' ? https : http;

                    // Filter and prepare headers (remove host, connection, etc. that shouldn't be forwarded)
                    const requestHeaders: Record<string, string> = {};
                    if (request.headers.range) {
                        requestHeaders['Range'] = request.headers.range;
                    }
                    // Add other headers that might be needed
                    if (request.headers['user-agent']) {
                        requestHeaders['User-Agent'] = request.headers['user-agent'];
                    }

                    const options = {
                        hostname: urlObj.hostname,
                        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                        path: urlObj.pathname + urlObj.search,
                        method: 'GET',
                        headers: requestHeaders,
                    };

                    logger.debug(`Starting HTTP request: ${rtmpVodUrl}, headers: ${JSON.stringify(requestHeaders)}`);

                    httpModule.get(options, async (httpResponse) => {
                        if (httpResponse.statusCode && httpResponse.statusCode >= 400) {
                            logger.error(`HTTP error: status=${httpResponse.statusCode}, message=${httpResponse.statusMessage}`);
                            reject(new Error(`Error loading the video: ${httpResponse.statusCode} - ${httpResponse.statusMessage}`));
                            return;
                        }

                        let contentType = httpResponse.headers['content-type'] || 'video/mp4';
                        const contentLength = httpResponse.headers['content-length'];
                        const contentRange = httpResponse.headers['content-range'];
                        const acceptRanges = httpResponse.headers['accept-ranges'] || 'bytes';

                        // Check if we need to convert FLV to MP4
                        const isFlv = typeof contentType === 'string' && (contentType === 'video/x-flv' || contentType === 'video/flv');

                        if (isFlv) {
                            logger.debug(`Content-Type is FLV (${contentType}), will convert to MP4 using ffmpeg`);
                        }

                        const responseHeaders: Record<string, string> = {
                            'Content-Type': typeof contentType === 'string' ? contentType : 'video/mp4',
                            'Accept-Ranges': typeof acceptRanges === 'string' ? acceptRanges : 'bytes',
                            'Cache-Control': 'no-cache',
                        };

                        if (contentLength) {
                            responseHeaders['Content-Length'] = typeof contentLength === 'string' ? contentLength : String(contentLength);
                        }

                        if (contentRange) {
                            responseHeaders['Content-Range'] = typeof contentRange === 'string' ? contentRange : String(contentRange);
                        }

                        const statusCode = httpResponse.statusCode || 200;

                        logger.debug(`HTTP response received: status=${statusCode}, contentType=${contentType}, contentLength=${contentLength || 'unknown'}`);

                        try {
                            if (isFlv) {
                                // Convert FLV to MP4 using ffmpeg
                                const ffmpegPath = await ffmpegPathPromise;
                                // Re-encode instead of copy because FLV codec might not be supported
                                const ffmpegArgs: string[] = [
                                    '-i', 'pipe:0', // Read from stdin (httpResponse)
                                    '-c:v', 'libx264', // Re-encode video to H.264
                                    '-preset', 'ultrafast', // Fast encoding for streaming
                                    '-tune', 'zerolatency', // Low latency
                                    '-c:a', 'aac', // Re-encode audio to AAC
                                    '-f', 'mp4',
                                    '-movflags', 'frag_keyframe+empty_moov', // Enable streaming
                                    'pipe:1', // Output to stdout
                                ];

                                const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
                                    stdio: ['pipe', 'pipe', 'pipe'],
                                });

                                let ffmpegError = '';
                                ffmpeg.stderr.on('data', (chunk: Buffer) => {
                                    ffmpegError += chunk.toString();
                                });

                                // Pipe httpResponse to ffmpeg stdin
                                httpResponse.pipe(ffmpeg.stdin);

                                ffmpeg.stdin.on('error', (err) => {
                                    // Ignore EPIPE errors when ffmpeg closes
                                    if ((err as any).code !== 'EPIPE') {
                                        logger.error(`FFmpeg stdin error: fileId=${fileId}`, err?.message || String(err));
                                    }
                                });

                                httpResponse.on('error', (err) => {
                                    logger.error(`HTTP response error before ffmpeg: fileId=${fileId}`, err?.message || String(err));
                                    try {
                                        ffmpeg.kill('SIGKILL');
                                    } catch (e) {
                                        // Ignore
                                    }
                                });

                                let streamStarted = false;

                                // Stream ffmpeg output
                                response.sendStream((async function* () {
                                    try {
                                        for await (const chunk of ffmpeg.stdout) {
                                            if (!streamStarted) {
                                                streamStarted = true;
                                            }
                                            yield chunk;
                                        }
                                    } catch (e) {
                                        logger.error(`Error streaming ffmpeg output: fileId=${fileId}`, e?.message || String(e));
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
                                        const sanitized = sanitizeFfmpegOutput(ffmpegError);
                                        logger.error(`FFmpeg conversion failed: fileId=${fileId}, code=${code}, error=${sanitized}`);
                                        reject(new Error(`FFmpeg conversion failed: ${code}`));
                                    } else {
                                        logger.debug(`FFmpeg conversion completed: fileId=${fileId}, code=${code}`);
                                        resolve();
                                    }
                                });

                                ffmpeg.on('error', (error) => {
                                    logger.error(`FFmpeg spawn error: fileId=${fileId}`, error?.message || String(error));
                                    reject(error);
                                });

                                logger.debug(`FFmpeg conversion started: fileId=${fileId}`);
                            } else {
                                // Direct proxy for non-FLV content (should be MP4 already)
                                // Stream directly without buffering - yield chunks as they arrive
                                response.sendStream((async function* () {
                                    try {
                                        for await (const chunk of Readable.from(httpResponse)) {
                                            yield chunk;
                                        }
                                        logger.log(`[VideoClip] Stream end: fileId=${fileId}`);
                                    } catch (streamErr) {
                                        logger.error(`[VideoClip] Stream error: fileId=${fileId}`, streamErr?.message || String(streamErr));
                                        throw streamErr;
                                    }
                                })(), {
                                    code: statusCode,
                                    headers: responseHeaders,
                                });

                                resolve();
                            }
                        } catch (err) {
                            logger.error(`Error sending stream: fileId=${fileId}`, err?.message || String(err));
                            reject(err);
                        }
                    }).on('error', (e) => {
                        logger.error(`Error fetching videoclip: fileId=${fileId}`, e?.message || String(e));
                        reject(e);
                    });
                });
            };

            try {
                await sendVideo();
                return;
            } catch (e) {
                logger.error(`HTTP proxy error: fileId=${fileId}`, e?.message || String(e));
                response.send('Failed to proxy HTTP stream', { code: 500 });
                return;
            }
        }

        // For RTMP URLs (camera standalone), use ffmpeg
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
                logger.log(`[VideoClip] Stream end: fileId=${fileId}`);
            } catch (e) {
                logger.error(`[VideoClip] Stream error: fileId=${fileId}`, e?.message || String(e));
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
                const sanitized = sanitizeFfmpegOutput(ffmpegError);
                logger.error(`FFmpeg proxy failed for video: fileId=${fileId}, code=${code}, error=${sanitized}`);
            }
        });

        ffmpeg.on('error', (error) => {
            logger.error(`FFmpeg spawn error for video proxy: fileId=${fileId}`, error?.message || String(error));
        });

        return;
    }
}

/**
 * Parse recordType string to extract detection classes
 * Based on the same logic as ReolinkCgiApi.parseRecordTypeFlags
 */
function parseRecordTypeToDetectionClasses(recordType?: string): string[] {
    const detectionClasses: string[] = [];

    if (!recordType) {
        return ['Motion']; // Default to Motion if no type specified
    }

    // Split by comma or whitespace and process each type
    const types = recordType.toLowerCase().split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

    let hasMotion = false;

    for (const t of types) {
        if (t === "people" || t === "person") {
            detectionClasses.push('Person');
        } else if (t === "vehicle" || t === "car") {
            detectionClasses.push('Vehicle');
        } else if (t === "dog_cat" || t === "animal" || t === "pet") {
            detectionClasses.push('Animal');
        } else if (t === "face") {
            detectionClasses.push('Face');
        } else if (t === "md" || t === "motion") {
            hasMotion = true;
        } else if (t === "visitor" || t === "doorbell") {
            detectionClasses.push('Doorbell');
        } else if (t === "package") {
            detectionClasses.push('Package');
        }
    }

    // Always include Motion as base (if not already added or if no other detections)
    if (hasMotion || detectionClasses.length === 0) {
        detectionClasses.unshift('Motion');
    }

    return detectionClasses;
}

/**
 * Extract detection classes from parsed filename flags (hex decoding)
 */
function parseFilenameFlagsToDetectionClasses(parsed?: ParsedRecordingFileName): string[] {
    const detectionClasses: string[] = [];
    const flags = parsed?.flags;

    if (!flags) {
        return [];
    }

    // Extract detection types from hex flags (same logic as enrichVodFile)
    if (flags.aiPerson) {
        detectionClasses.push('Person');
    }
    if (flags.aiVehicle) {
        detectionClasses.push('Vehicle');
    }
    if (flags.aiAnimal) {
        detectionClasses.push('Animal');
    }
    if (flags.aiFace) {
        detectionClasses.push('Face');
    }
    if (flags.motion) {
        detectionClasses.push('Motion');
    }
    if (flags.doorbell) {
        detectionClasses.push('Doorbell');
    }
    if (flags.package) {
        detectionClasses.push('Package');
    }

    return detectionClasses;
}

/**
 * Convert Reolink time format to Date
 * Uses UTC to match the API's dateToReolinkTime conversion
 */
function reolinkTimeToDate(time: { year: number; mon: number; day: number; hour: number; min: number; sec: number }): Date {
    return new Date(Date.UTC(
        time.year,
        time.mon - 1,
        time.day,
        time.hour,
        time.min,
        time.sec
    ));
}

/**
 * Convert VOD search results to VideoClip array
 */
export async function vodSearchResultsToVideoClips(
    vodResults: Array<VodSearchResponse>,
    options: {
        deviceId: string;
        plugin: ScryptedDeviceBase;
        logger?: Console;
    }
): Promise<VideoClip[]> {
    const { deviceId, plugin, logger } = options;
    const clips: VideoClip[] = [];

    // Import parseRecordingFileName once (it's exported from the package)
    const reolinkModule = await import("@apocaliss92/reolink-baichuan-js");
    const parseRecordingFileName = reolinkModule.parseRecordingFileName;

    // Process VOD search results
    for (const result of vodResults) {
        if (result.code !== 0) {
            logger?.debug(`VOD search result code: ${result.code}`, result.error);
            continue;
        }

        const searchResult = result.value?.SearchResult;
        if (!searchResult?.File || !Array.isArray(searchResult.File)) {
            continue;
        }

        // Convert each VOD file to VideoClip
        for (const file of searchResult.File) {
            try {
                // Parse filename to extract flags (like enrichVodFile does)
                const parsed = parseRecordingFileName(file.name);

                // Get times from parsed filename or from StartTime/EndTime
                // Camera times in StartTime/EndTime are in local timezone (not UTC)
                // Use local time constructor to preserve the timezone
                const fileStart = parsed?.start ?? new Date(
                    file.StartTime.year,
                    file.StartTime.mon - 1,
                    file.StartTime.day,
                    file.StartTime.hour,
                    file.StartTime.min,
                    file.StartTime.sec
                );
                const fileEnd = parsed?.end ?? new Date(
                    file.EndTime.year,
                    file.EndTime.mon - 1,
                    file.EndTime.day,
                    file.EndTime.hour,
                    file.EndTime.min,
                    file.EndTime.sec
                );

                const duration = fileEnd.getTime() - fileStart.getTime();
                const fileName = file.name || '';

                // Extract detection classes from both filename flags (hex) and file.type
                const filenameFlags = parseFilenameFlagsToDetectionClasses(parsed);
                const typeFlags = parseRecordTypeToDetectionClasses(file.type);

                // Debug: log file.type to see what we're parsing
                if (logger && file.type) {
                    logger.debug(`[VOD] Parsing file.type="${file.type}" for file=${fileName}, filenameFlags=${filenameFlags.join(',')}, typeFlags=${typeFlags.join(',')}`);
                }

                // Merge both sources (OR them together, like enrichVodFile does)
                // Remove duplicates and ensure Motion is included if any detection is found
                const allDetections = [...filenameFlags, ...typeFlags];
                const detectionClasses = [...new Set(allDetections)];

                // If we have detections from filename flags, use those (they're more accurate)
                // Otherwise use type flags, or default to Motion
                if (detectionClasses.length === 0) {
                    detectionClasses.push('Motion');
                } else if (!detectionClasses.includes('Motion') && (filenameFlags.length > 0 || typeFlags.some(t => t.toLowerCase().includes('motion') || t.toLowerCase().includes('md')))) {
                    // Add Motion if we have other detections but Motion is not explicitly included
                    detectionClasses.push('Motion');
                }

                // Generate webhook URLs
                let videoHref: string | undefined;
                let thumbnailHref: string | undefined;
                try {
                    const { videoUrl, thumbnailUrl } = await getVideoClipWebhookUrls({
                        deviceId,
                        fileId: fileName,
                        plugin,
                        logger,
                    });
                    videoHref = videoUrl;
                    thumbnailHref = thumbnailUrl;
                } catch (e) {
                    logger?.debug('Failed to generate webhook URLs for VOD file', fileName, e);
                }

                const clip: VideoClip = {
                    id: fileName,
                    description: fileName,
                    startTime: fileStart.getTime(),
                    duration,
                    resources: {
                        video: videoHref ? { href: videoHref } : undefined,
                        thumbnail: thumbnailHref ? { href: thumbnailHref } : undefined,
                    },
                    detectionClasses,
                };

                clips.push(clip);
            } catch (e) {
                logger?.warn(`Failed to convert VOD file to clip: ${file.name}`, e);
            }
        }
    }

    return clips;
}