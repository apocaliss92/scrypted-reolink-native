import type {
  DeviceCapabilities,
  RecordingFile,
  ReolinkBaichuanApi,
  ReolinkDeviceInfo,
  ReolinkSupportedStream
} from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, {
  DeviceBase,
  HttpRequest,
  HttpResponse,
  MediaObject,
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  VideoClip,
} from "@scrypted/sdk";
import crypto from "crypto";
import path from "path";
import { ReolinkCamera } from "./camera";
/**
 * Sanitize FFmpeg output or URLs to avoid leaking credentials
 */
export function sanitizeFfmpegOutput(text: string): string {
  if (!text) return text;

  let sanitized = text;

  // Remove user/password query parameters from URLs: ?user=xxx&password=yyy
  sanitized = sanitized.replace(/(\buser=)[^&\s]*/gi, "$1***");
  sanitized = sanitized.replace(/(\bpassword=)[^&\s]*/gi, "$1***");

  // Remove credentials from URLs like rtmp://user:pass@host/...
  sanitized = sanitized.replace(
    /(rtmp:\/\/)([^:@\/\s]+):([^@\/\s]+)@/gi,
    "$1$2:***@",
  );

  return sanitized;
}

/**
 * Enumeration of operation types that may require specific channel assignments
 */
export enum OperationChannelType {
  PAN = "pan",
  TILT = "tilt",
  ZOOM = "zoom",
  INTERCOM = "intercom",
  GOTO = "goto",
  PRESET = "preset",
  PATROL = "patrol",
  TRACK = "track",
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
export const motionSirenSuffix = `-motion-siren`;
export const motionFloodlightSuffix = `-motion-floodlight`;
export const pirSuffix = `-pir`;

export const getDeviceInterfaces = (props: {
  capabilities: DeviceCapabilities;
  logger: Console;
  isLensDevice?: boolean;
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
    logger.error("Error getting device interfaces", e?.message || String(e));
  }

  return {
    interfaces,
    type: capabilities.isDoorbell
      ? ScryptedDeviceType.Doorbell
      : ScryptedDeviceType.Camera,
  };
};

export const updateDeviceInfo = async (props: {
  device: DeviceBase;
  ipAddress: string;
  deviceData: ReolinkDeviceInfo;
  logger: Console;
}) => {
  const { device, ipAddress, deviceData, logger } = props;
  try {
    const info = device.info || {};

    info.ip = ipAddress;
    info.serialNumber = deviceData?.serialNumber || deviceData?.itemNo;
    info.firmware = deviceData?.firmwareVersion;
    info.version = deviceData?.hardwareVersion;
    info.model = deviceData?.type;
    info.manufacturer = "Reolink";
    info.managementUrl = `http://${ipAddress}`;
    device.info = info;
  } catch (e) {
    // If API call fails, at least set basic info
    const info = device.info || {};
    info.ip = ipAddress;
    info.manufacturer = "Reolink native";
    info.managementUrl = `http://${ipAddress}`;
    device.info = info;

    throw e;
  } finally {
    logger.log(`Device info updated`);
    logger.debug(`${JSON.stringify({ newInfo: device.info, deviceData })}`);
  }
};

/**
 * Convert a Reolink RecordingFile to a Scrypted VideoClip
 */
export async function recordingFileToVideoClip(
  rec: RecordingFile,
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
  },
): Promise<VideoClip> {
  const {
    fallbackStart,
    api,
    videoHref: providedVideoHref,
    logger,
    plugin,
    deviceId,
    useWebhook,
  } = options;

  // Handle RecordingFile (has startTime/endTime as Date)
  let recStart: Date;
  let recEnd: Date;

  if ("startTime" in rec && rec.startTime instanceof Date) {
    recStart = rec.startTime;
  } else {
    recStart = rec.parsedFileName?.start ?? fallbackStart;
  }

  if ("endTime" in rec && rec.endTime instanceof Date) {
    recEnd = rec.endTime;
  } else {
    recEnd = rec.parsedFileName?.end ?? recStart;
  }

  const recStartMs = recStart.getTime();
  const recEndMs = Math.max(recEnd.getTime(), recStartMs);
  const duration = recEndMs - recStartMs;

  // IMPORTANT: For NVR/Hub, ensure the clip id (fileId) is the actual recording path (/mnt/...) when available.
  // Some sources may provide an alternate id (e.g. eventId/Baichuan id); we prefer the filesystem path because
  // downstream VOD download/playback endpoints expect it.
  const id =
    typeof rec.fileName === "string" && rec.fileName.startsWith("/mnt/")
      ? rec.fileName
      : rec.id || rec.fileName;

  // Get video URL if not provided
  let videoHref: string | undefined = providedVideoHref;
  let thumbnailHref: string | undefined;

  // logger?.debug(`[recordingFileToVideoClip] URL generation: useWebhook=${useWebhook}, hasPlugin=${!!plugin}, deviceId=${deviceId}, providedVideoHref=${providedVideoHref || 'none'}, hasApi=${!!api}`);

  // If webhook is enabled, generate webhook URLs
  if (useWebhook && plugin && deviceId) {
    // logger?.debug(`[recordingFileToVideoClip] Generating webhook URLs for fileId=${id}`);
    try {
      const { videoUrl, thumbnailUrl } = await getVideoClipWebhookUrls({
        deviceId,
        fileId: id,
        plugin,
        logger,
      });
      videoHref = videoUrl;
      thumbnailHref = thumbnailUrl;
      // logger?.debug(`[recordingFileToVideoClip] Webhook URLs generated successfully: videoHref="${videoHref}", thumbnailHref="${thumbnailHref}"`);
    } catch (e) {
      logger?.error(
        `[recordingFileToVideoClip] Failed to generate webhook URLs for fileId=${id}:`,
        e?.message || String(e),
      );
    }
  } else if (!videoHref && api) {
    // Fallback to direct URL if webhook is not used.
    // Prefer HTTP Download when possible; otherwise fall back to RTMP.
    try {
      const channel = api.client.getConfiguredChannel?.() ?? 0;
      try {
        const url = await api.getVodUrl(rec.fileName, channel, {
          requestType: "Download",
          streamType: "main",
          prepare: false,
        });
        if (url?.startsWith("http://") || url?.startsWith("https://")) {
          videoHref = url;
        }
      } catch {
        // ignore and fall back to RTMP
      }

      if (!videoHref) {
        const { rtmpVodUrl } = await api.getRecordingPlaybackUrls({
          fileName: rec.fileName,
        });
        videoHref = rtmpVodUrl;
      }
    } catch (e) {
      logger?.debug(
        `[recordingFileToVideoClip] Failed to build playback URL for recording fileName=${rec.fileName}:`,
        e?.message || String(e),
      );
    }
  } else {
    // logger?.debug(`[recordingFileToVideoClip] No URL generation: useWebhook=${useWebhook}, hasPlugin=${!!plugin}, deviceId=${deviceId}, providedVideoHref=${providedVideoHref || 'none'}, hasApi=${!!api}`);
  }

  const description =
    "name" in rec && typeof rec.name === "string" && rec.name
      ? rec.name
      : (rec.fileName ?? rec.id ?? "");

  // Build detectionClasses from parsedFileName.flags or recordType
  const detectionClasses: string[] = [];

  // Check parsedFileName.flags first (from filename hex decoding)
  let hasAnyDetection = false;
  const flags = rec.parsedFileName?.flags;
  if (flags) {
    if (flags.aiPerson) {
      detectionClasses.push("Person");
      hasAnyDetection = true;
    }
    if (flags.aiVehicle) {
      detectionClasses.push("Vehicle");
      hasAnyDetection = true;
    }
    if (flags.aiAnimal) {
      detectionClasses.push("Animal");
      hasAnyDetection = true;
    }
    if (flags.aiFace) {
      detectionClasses.push("Face");
      hasAnyDetection = true;
    }
    if (flags.motion) {
      detectionClasses.push("Motion");
      hasAnyDetection = true;
    }
    if (flags.doorbell) {
      detectionClasses.push("Doorbell");
      hasAnyDetection = true;
    }
    if (flags.package) {
      detectionClasses.push("Package");
      hasAnyDetection = true;
    }
  }

  // Fallback: parse recordType string if flags are not available
  if (!hasAnyDetection && rec.recordType) {
    const recordTypeLower = rec.recordType.toLowerCase();
    if (
      recordTypeLower.includes("people") ||
      recordTypeLower.includes("person")
    ) {
      detectionClasses.push("Person");
    }
    if (recordTypeLower.includes("vehicle")) {
      detectionClasses.push("Vehicle");
    }
    if (
      recordTypeLower.includes("dog_cat") ||
      recordTypeLower.includes("animal")
    ) {
      detectionClasses.push("Animal");
    }
    if (recordTypeLower.includes("face")) {
      detectionClasses.push("Face");
    }
    if (recordTypeLower.includes("md") || recordTypeLower.includes("motion")) {
      detectionClasses.push("Motion");
    }
    if (
      recordTypeLower.includes("visitor") ||
      recordTypeLower.includes("doorbell")
    ) {
      detectionClasses.push("Doorbell");
    }
    if (recordTypeLower.includes("package")) {
      detectionClasses.push("Package");
    }
  }

  // Always include Motion if no other detections found
  if (detectionClasses.length === 0) {
    detectionClasses.push("Motion");
  }

  const resources =
    videoHref || thumbnailHref
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
    detectionClasses:
      detectionClasses.length > 0 ? detectionClasses : undefined,
    resources,
  };
}

/**
 * Convert an array of RecordingFile to VideoClip array
 * Uses recordingFileToVideoClip for each recording
 */
export async function recordingsToVideoClips(
  recordings: RecordingFile[],
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
  },
): Promise<VideoClip[]> {
  const { fallbackStart, api, logger, plugin, deviceId, useWebhook, count } =
    options;
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
      logger?.warn(
        `Failed to convert recording to video clip: fileName=${rec.fileName}`,
        e?.message || String(e),
      );
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
    let endpointSource: "cloud" | "local";
    try {
      endpoint = await sdk.endpointManager.getCloudEndpoint(undefined, {
        public: true,
      });
      endpointSource = "cloud";
      // log.debug?.(`[getVideoClipWebhookUrls] Using cloud endpoint: ${endpoint}`);
    } catch (e) {
      // Fallback to local endpoint if cloud is not available (e.g., not logged in)
      log.debug?.(
        `[getVideoClipWebhookUrls] Cloud endpoint not available, using local endpoint: ${e?.message || String(e)}`,
      );
      endpoint = await sdk.endpointManager.getLocalEndpoint(undefined, {
        public: true,
      });
      endpointSource = "local";
      // log.debug?.(`[getVideoClipWebhookUrls] Using local endpoint: ${endpoint}`);
    }

    const encodedDeviceId = encodeURIComponent(deviceId);
    // Remove leading slash from fileId if present, as it causes invalid paths when encoded
    const cleanFileId = fileId.startsWith("/") ? fileId.substring(1) : fileId;
    const encodedFileId = encodeURIComponent(cleanFileId);

    // Parse endpoint URL to extract query parameters (for authentication)
    const endpointUrl = new URL(endpoint);
    // Preserve query parameters (e.g., user_token for authentication)
    const queryParams = endpointUrl.search;
    // Remove query parameters from the base endpoint URL
    endpointUrl.search = "";

    // Ensure endpoint has trailing slash
    const normalizedEndpoint = endpointUrl.toString().endsWith("/")
      ? endpointUrl.toString()
      : `${endpointUrl.toString()}/`;

    // Build webhook URLs and append query parameters at the end
    const videoUrl = `${normalizedEndpoint}webhook/video/${encodedDeviceId}/${encodedFileId}${queryParams}`;
    const thumbnailUrl = `${normalizedEndpoint}webhook/thumbnail/${encodedDeviceId}/${encodedFileId}${queryParams}`;

    return { videoUrl, thumbnailUrl };
  } catch (e) {
    log.error?.(
      `[getVideoClipWebhookUrls] Failed to generate webhook URLs: deviceId=${deviceId}, fileId=${fileId}`,
      e?.message || String(e),
    );
    throw e;
  }
}

/**
 * Handle video clip webhook request
 * Uses progressive streaming for immediate playback.
 * Stream management (stopping previous streams, cooldown) is handled by the API layer
 * in ReolinkBaichuanApi.createRecordingReplayMp4Stream via activeReplayStreams per channel.
 */
export async function handleVideoClipRequest(props: {
  device: ReolinkCamera;
  deviceId: string;
  fileId: string;
  request: HttpRequest;
  response: HttpResponse;
  logger?: Console;
}): Promise<void> {
  const { device, fileId, request, response } = props;
  const logger = device.getBaichuanLogger?.() || props.logger || console;
  const useHttpSource =
    device.storageSettings?.values?.videoclipSource === "HTTP";

  logger.log(
    `[VideoClip] REQUEST: fileId=${fileId.slice(-40)}, isOnNvr=${device.isOnNvr}, source=${useHttpSource ? "HTTP" : "Native"}`,
  );

  try {
    const api = await device.ensureClient();
    const channel = device.storageSettings?.values?.rtspChannel ?? 0;

    if (useHttpSource) {
      // HTTP mode: use CGI API to download the video file
      logger.debug(`[VideoClip] Using CGI API (HTTP) to download: ${fileId}`);

      const mp4Buffer = await api.downloadVod(fileId, {
        output: fileId,
      });

      logger.debug(`[VideoClip] Downloaded via CGI: ${mp4Buffer.length} bytes`);

      // Send the buffer as a complete response
      const CHUNK_SIZE = 64 * 1024; // 64KB chunks
      response.sendStream(
        (async function* () {
          let offset = 0;
          while (offset < mp4Buffer.length) {
            const end = Math.min(offset + CHUNK_SIZE, mp4Buffer.length);
            yield mp4Buffer.subarray(offset, end);
            offset = end;
          }
        })(),
        {
          code: 200,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": mp4Buffer.length.toString(),
            "Cache-Control": "no-cache",
          },
        },
      );
      return;
    }

    // Native mode: use Baichuan streaming replay
    // Add error handler to prevent uncaughtException from client socket errors
    const onClientError = (err: Error) => {
      logger.warn?.(
        `[VideoClip] Client error during stream: ${err?.message || "unknown"}`,
      );
    };
    api.client.on("error", onClientError);

    // Use streaming replay - this starts immediately and produces fMP4 chunks
    // Stream management (stopping previous streams, cooldown) is handled by the API layer
    // Generate a unique session ID based on client fingerprint (UA + IP + other factors)
    // This allows the same client to reuse the dedicated socket when switching clips
    const clientFingerprint = [
      request.headers?.["user-agent"] || "",
      request.headers?.["x-forwarded-for"] ||
        request.headers?.["x-real-ip"] ||
        "",
      request.headers?.["accept-language"] || "",
      request.headers?.["accept-encoding"] || "",
    ].join("|");
    const sessionId =
      request.headers?.["x-request-id"] ||
      crypto
        .createHash("sha256")
        .update(clientFingerprint)
        .digest("hex")
        .slice(0, 16);
    const { mp4: mp4Stream, stop } = await api.createRecordingReplayMp4Stream({
      channel,
      fileName: fileId,
      isNvr: device.isOnNvr,
      logger,
      deviceId: sessionId,
    });

    let totalSize = 0;

    // Simple response - no range support
    response.sendStream(
      (async function* () {
        try {
          for await (const chunk of mp4Stream) {
            yield chunk;
            totalSize += chunk.length;
          }
        } catch (e: any) {
          // Stream error - library handles logging
        } finally {
          // Remove the error handler
          api.client.off("error", onClientError);
          await stop().catch(() => {});
        }
      })(),
      {
        code: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Cache-Control": "no-cache",
        },
      },
    );
    return;
  } catch (streamErr: any) {
    logger.error(
      `[VideoClip] Streaming failed: ${streamErr?.message || String(streamErr)}`,
    );
    response.send(
      `Streaming failed: ${streamErr?.message || "Unknown error"}`,
      {
        code: 500,
      },
    );
    return;
  }
}

export const removeAuthUrls = (streams: ReolinkSupportedStream[]) =>
  streams.map(({ urlWithAuth, ...rest }) => ({ rest }));
