import type {
  DeviceCapabilities,
  RecordingFile,
  ReolinkDeviceInfo,
  ReolinkSupportedStream,
} from "@apocaliss92/nodelink-js" with { "resolution-mode": "import" };
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
export const udpCameraSuffix = `-udp-cam`; // UDP camera without battery (e.g., Elite Floodlight WiFi)
export const multifocalSuffix = `-multifocal`;
export const batteryMultifocalSuffix = `-battery-multifocal`;
export const udpMultifocalSuffix = `-udp-multifocal`; // UDP multifocal without battery
export const cameraSuffix = `-cam`;
export const sirenSuffix = `-siren`;
export const floodlightSuffix = `-floodlight`;
export const motionSirenSuffix = `-motion-siren`;
export const motionFloodlightSuffix = `-motion-floodlight`;
export const pirSuffix = `-pir`;
export const autotrackingSuffix = `-autotracking`;
export const chimeSuffix = `-chime`;

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
    if (hasIntercom) {
      // Declared on the device itself, not left to the intercom mixin, and the
      // distinction decides whether two-way audio can work at all.
      //
      // Scrypted composes mixins in array order and passes each one only the
      // interfaces accumulated before it (`previousInterfaces` in
      // server/src/plugin/plugin-device.ts). The WebRTC mixin reads that list:
      //
      //     const hasIntercom = this.mixinDeviceInterfaces.includes(ScryptedInterface.Intercom);
      //     ...
      //     hasIntercom ? 'sendrecv' : 'recvonly',
      //
      // and `recvonly` makes it call `addTransceiver(atrack, { direction })`
      // with a direction that refuses a client microphone track. The client is
      // then never asked for one — iOS never shows the orange recording
      // indicator — and `setPlaybackInternal` parks forever on
      // `audioTransceiver.onTrack.asPromise()`, so `startIntercom` is never
      // reached and the plugin logs nothing at all.
      //
      // A mixin-supplied interface only reaches mixins ordered after it, which
      // made this depend on chain order. Interfaces provided by the device are
      // the base every mixin starts from, so this is order-independent. It is
      // also what the official @scrypted/reolink plugin does: its ReolinkCamera
      // implements Intercom directly and lists it in the device manifest.
      interfaces.push(ScryptedInterface.Intercom);
    }
    interfaces.push(ScryptedInterface.ObjectDetector);
    if (hasSiren || hasFloodlight || hasPir)
      interfaces.push(ScryptedInterface.DeviceProvider);
    if (hasBattery) {
      interfaces.push(ScryptedInterface.Battery, ScryptedInterface.Sleep, ScryptedInterface.Charger);
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
    logger.debug({ newInfo: device.info, deviceData });
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

const getHeader = (headers: Record<string, any> | undefined, key: string) => {
  return (
    headers?.[key] ??
    headers?.[key.toLowerCase()] ??
    headers?.[key.toUpperCase()]
  );
};

export const getVideoclipClientInfo = (request: HttpRequest) => {
  return {
    userAgent:
      getHeader(request.headers, "user-agent") ??
      getHeader(request.headers, "User-Agent"),
    accept:
      getHeader(request.headers, "accept") ??
      getHeader(request.headers, "Accept"),
    range:
      getHeader(request.headers, "range") ??
      getHeader(request.headers, "Range"),
    secChUa:
      getHeader(request.headers, "sec-ch-ua") ??
      getHeader(request.headers, "Sec-CH-UA"),
    secChUaMobile:
      getHeader(request.headers, "sec-ch-ua-mobile") ??
      getHeader(request.headers, "Sec-CH-UA-Mobile"),
    secChUaPlatform:
      getHeader(request.headers, "sec-ch-ua-platform") ??
      getHeader(request.headers, "Sec-CH-UA-Platform"),
  };
};

const getQueryParam = (requestUrl: string | undefined, key: string) => {
  if (!requestUrl) return undefined;
  try {
    const url = new URL(requestUrl, "http://localhost");
    const v = url.searchParams.get(key);
    return v === null ? undefined : v;
  } catch {
    return undefined;
  }
};

const withQueryParam = (requestUrl: string, key: string, value: string) => {
  try {
    const url = new URL(requestUrl, "http://localhost");
    url.searchParams.set(key, value);
    return url.pathname + (url.search ? url.search : "");
  } catch {
    const sep = requestUrl.includes("?") ? "&" : "?";
    return `${requestUrl}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
};

let baichuanRuntimePromise:
  | Promise<{
      detectIosClient: (userAgent: string | undefined) => {
        isIos: boolean;
        isIosInstalledApp: boolean;
        needsHls: boolean;
      };
      HlsSessionManager: new (
        api: any,
        options?: {
          logger?: any;
          sessionTtlMs?: number;
          cleanupIntervalMs?: number;
        },
      ) => any;
    }>
  | undefined;

const getBaichuanRuntime = async () => {
  if (!baichuanRuntimePromise) {
    baichuanRuntimePromise = import("@apocaliss92/nodelink-js") as any;
  }
  return baichuanRuntimePromise;
};

const hlsManagersByApi = new WeakMap<object, any>();

const videoclipLogThrottle = new Map<string, number>();
const shouldLogThrottled = (key: string, intervalMs: number): boolean => {
  const now = Date.now();
  const last = videoclipLogThrottle.get(key);
  if (last !== undefined && now - last < intervalMs) return false;
  videoclipLogThrottle.set(key, now);
  // Best-effort guard against unbounded growth.
  if (videoclipLogThrottle.size > 5000) videoclipLogThrottle.clear();
  return true;
};

/**
 * Handle video clip webhook request.
 *
 * Playback modes (checked in order):
 * 1. **HLS** – All iOS clients (Safari, AVPlayer, InstalledApp) or explicit `?hls=` query param.
 *    Uses HlsSessionManager for adaptive HLS delivery with progressive segments (~3-5s to first frame).
 *    iOS AVFoundation requires Content-Length + Range support for regular MP4, but generating the
 *    full MP4 upfront takes too long (camera download + transcode = 25+ seconds, causing timeout).
 *    HLS solves this by streaming segments progressively.
 * 2. **Stream** – All other clients (desktop browsers, etc.).
 *    Progressive fMP4 streaming with unknown total size. Fast startup.
 *
 * Stream management (stopping previous streams, cooldown) is handled by the API
 * layer in ReolinkBaichuanApi.createRecordingReplayMp4Stream via activeReplayStreams
 * per channel.
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

  // Check if iOS client
  const clientInfo = getVideoclipClientInfo(request);
  const hlsPath = getQueryParam(request.url, "hls");
  const hlsSocketMode = (getQueryParam(request.url, "hlsSocket") ?? "device")
    .toString()
    .toLowerCase();

  let ios: {
    isIos: boolean;
    isIosInstalledApp: boolean;
    needsHls: boolean;
  } = {
    isIos: /iphone|ipad|ipod/i.test(clientInfo.userAgent ?? ""),
    isIosInstalledApp: /(installedapp)/i.test(clientInfo.userAgent ?? ""),
    needsHls: false,
  };

  try {
    const mod = await getBaichuanRuntime();
    ios = mod.detectIosClient(clientInfo.userAgent);
  } catch {
    // If dynamic import fails, keep best-effort UA detection.
    // ALL iOS clients should use HLS for reliable recording playback.
    ios.needsHls = ios.isIos;
  }

  // All iOS clients use HLS for video clip playback (Safari, AVPlayer, InstalledApp).
  // HLS streams segments progressively (~3-5s to first frame) instead of buffering
  // the entire MP4 upfront (25+ seconds, causing iOS timeout).
  // If `?hls=` is present, always serve HLS assets (playlist/segments) regardless of client.
  const shouldUseHls = ios.needsHls || hlsPath !== undefined;

  // These endpoints can be very chatty (HLS playlist polling + segment fetch).
  // Keep important transitions visible, but push repetitive per-request noise to debug.
  const requestMode = shouldUseHls ? "HLS" : "Stream";
  const requestHlsPathForLog = shouldUseHls ? (hlsPath ?? "playlist.m3u8") : "";
  const isHlsSegmentReq =
    shouldUseHls && requestHlsPathForLog.toString().endsWith(".ts");
  const reqLogKey = `VideoClip:REQ:${props.deviceId}:${fileId}:${requestMode}:${requestHlsPathForLog}`;
  const reqLine = `[VideoClip] REQUEST: fileId=${fileId.slice(-40)}, isOnNvr=${device.isOnNvr}, isIos=${ios.isIos}, isIosInstalledApp=${ios.isIosInstalledApp}, hls=${shouldUseHls}, hlsPath=${JSON.stringify(hlsPath)}, hlsSocket=${hlsSocketMode}, mode=${requestMode}`;
  if (isHlsSegmentReq) {
    logger.debug?.(reqLine);
  } else if (shouldLogThrottled(reqLogKey, 2000)) {
    logger.log(reqLine);
  } else {
    logger.debug?.(reqLine);
  }

  try {
    const api = await device.ensureClient();
    const channel = device.storageSettings?.values?.rtspChannel ?? 0;

    if (shouldUseHls) {
      const mod = await getBaichuanRuntime();
      let manager = hlsManagersByApi.get(api as any);
      if (!manager) {
        manager = new mod.HlsSessionManager(api as any, {
          logger: logger as any,
          // Keep very short: iOS HLS requests are frequent; if the client stops
          // requesting playlists/segments we want to tear down quickly.
          sessionTtlMs: 15 * 1000,
          cleanupIntervalMs: 5 * 1000,
        });
        hlsManagersByApi.set(api as any, manager);
      }
      const sessionKey = `hls:${props.deviceId}:ch${channel}:${fileId}`;
      const exclusiveKeyPrefix = `hls:${props.deviceId}:ch${channel}:`;

      // Treat the base clip URL as a playlist request to avoid an extra 302
      // round-trip on clip switches.
      const effectiveHlsPath = hlsPath ?? "playlist.m3u8";

      const result = await manager.handleRequest({
        sessionKey,
        hlsPath: effectiveHlsPath,
        requestUrl: request.url ?? "",
        exclusiveKeyPrefix,
        createSession: () => ({
          channel,
          fileName: fileId,
          isNvr: device.isOnNvr,
          // Default: reuse a dedicated replay socket per device for fast clip switching.
          // Override: `?hlsSocket=clip` forces a fresh socket per clip (more robust, slower).
          deviceId:
            hlsSocketMode === "clip"
              ? `${props.deviceId}:${fileId}`
              : props.deviceId,
          // Lower duration improves startup latency on iOS.
          hlsSegmentDuration: 1,
          transcodeH265ToH264: true,
        }),
      });

      const bodyLen =
        typeof result.body === "string"
          ? result.body.length
          : (result.body?.length ?? 0);

      const respLine = `[VideoClip] HLS RESP: hlsPath=${JSON.stringify(effectiveHlsPath)}, status=${result.statusCode}, len=${bodyLen}`;
      const isError = result.statusCode >= 400;
      const isSegment = effectiveHlsPath.endsWith(".ts");
      const respLogKey = `VideoClip:RESP:${props.deviceId}:${fileId}:${effectiveHlsPath}:${result.statusCode}`;
      if (isError) {
        (logger.warn ?? logger.log).call(logger, respLine);
      } else if (isSegment) {
        logger.debug?.(respLine);
      } else if (shouldLogThrottled(respLogKey, 2000)) {
        logger.log(respLine);
      } else {
        logger.debug?.(respLine);
      }

      response.send(result.body as any, {
        code: result.statusCode,
        headers: result.headers,
      });
      return;
    }

    // Stream mode (non-iOS clients): use Baichuan streaming replay
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
    const explicitSessionId =
      getHeader(request.headers, "x-playback-session-id") ??
      getHeader(request.headers, "X-Playback-Session-Id");
    const sessionId =
      explicitSessionId ||
      request.headers?.["x-request-id"] ||
      crypto
        .createHash("sha256")
        .update(clientFingerprint)
        .digest("hex")
        .slice(0, 16);

    logger.debug(
      `[VideoClip] Client info: ${JSON.stringify({
        clientInfo,
        isIos: ios.isIos,
        isIosInstalledApp: ios.isIosInstalledApp,
      })}`,
    );

    const { mp4: mp4Stream, stop } = await api.createRecordingReplayMp4Stream({
      channel,
      fileName: fileId,
      isNvr: device.isOnNvr,
      logger,
      deviceId: sessionId,
      // Browsers (Chrome/Firefox) can't decode H.265/HEVC in MSE, so a raw
      // passthrough of an HEVC recording loads but never plays. The library
      // only transcodes when the source is actually H.265 (H.264 is copied
      // untouched), so this is safe to always request. Mirrors the HLS path.
      transcodeH265ToH264: true,
    });

    let totalSize = 0;

    // No Range: stream the full fMP4 response (unknown total size)
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
          "Content-Disposition": 'inline; filename="clip.mp4"',
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
