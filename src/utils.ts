import type {
  DeviceCapabilities,
  RecordingFile,
  ReolinkDeviceInfo,
  ReolinkSupportedStream,
} from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import sdk, {
  DeviceBase,
  HttpRequest,
  HttpResponse,
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  VideoClip,
} from "@scrypted/sdk";
import crypto from "crypto";
import { ReolinkCamera } from "./camera";

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
export const autotrackingSuffix = `-autotracking`;

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
 * Simple mapping - all data is already in RecordingFile
 */
export async function recordingFileToVideoClip(
  rec: RecordingFile,
  options: {
    /** Plugin instance for generating webhook URLs */
    plugin: ScryptedDeviceBase;
    /** Device ID for webhook URLs */
    deviceId: string;
    /** Logger for debug messages */
    logger?: Console;
  },
): Promise<VideoClip> {
  const { plugin, deviceId, logger } = options;

  // Get times from RecordingFile (already parsed)
  const recStart = rec.startTime ?? rec.parsedFileName?.start ?? new Date();
  const recEnd = rec.endTime ?? rec.parsedFileName?.end ?? recStart;

  const recStartMs = recStart.getTime();
  const recEndMs = Math.max(recEnd.getTime(), recStartMs);
  const duration = recEndMs - recStartMs;

  // Use fileName as id (for NVR it's the full path like /mnt/...)
  const id = rec.id || rec.fileName;

  // Generate webhook URLs
  let videoHref: string | undefined;
  let thumbnailHref: string | undefined;

  try {
    const { videoUrl, thumbnailUrl } = await getVideoClipWebhookUrls({
      deviceId,
      fileId: id,
      plugin,
      logger,
    });
    videoHref = videoUrl;
    thumbnailHref = thumbnailUrl;
  } catch (e) {
    logger?.error(
      `[recordingFileToVideoClip] Failed to generate webhook URLs for fileId=${id}:`,
      e?.message || String(e),
    );
  }

  // Use detectionClasses from RecordingFile (already populated by CGI/Baichuan API)
  // Default to motion if not available
  const detectionClasses = rec.detectionClasses ?? ["motion"];

  return {
    id,
    startTime: recStartMs,
    duration,
    event: rec.recordType,
    description: rec.name || rec.fileName || rec.id || "",
    detectionClasses,
    resources:
      videoHref || thumbnailHref
        ? {
            ...(videoHref ? { video: { href: videoHref } } : {}),
            ...(thumbnailHref ? { thumbnail: { href: thumbnailHref } } : {}),
          }
        : undefined,
  };
}

/**
 * Convert an array of RecordingFile to VideoClip array
 * Simple mapping with optional limit
 */
export async function recordingsToVideoClips(
  recordings: RecordingFile[],
  options: {
    /** Plugin instance for generating webhook URLs */
    plugin: ScryptedDeviceBase;
    /** Device ID for webhook URLs */
    deviceId: string;
    /** Logger for debug messages */
    logger?: Console;
    /** Maximum number of clips to return (optional) */
    count?: number;
  },
): Promise<VideoClip[]> {
  const { plugin, deviceId, logger, count } = options;

  const clipPromises = recordings.map(async (rec) => {
    try {
      return await recordingFileToVideoClip(rec, { plugin, deviceId, logger });
    } catch (e) {
      logger?.warn(
        `Failed to convert recording to video clip: fileName=${rec.fileName}`,
        e?.message || String(e),
      );
      return null;
    }
  });

  const clips = await Promise.all(clipPromises);
  const validClips = clips.filter((c): c is VideoClip => c !== null);
  return count ? validClips.slice(0, count) : validClips;
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
