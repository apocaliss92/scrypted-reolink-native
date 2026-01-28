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

const getHeader = (headers: Record<string, any> | undefined, key: string) => {
  return (
    headers?.[key] ??
    headers?.[key.toLowerCase()] ??
    headers?.[key.toUpperCase()]
  );
};

const videoclipDownloadCache = new Map<
  string,
  { ts: number; promise: Promise<Buffer> }
>();
const VIDEOCLIP_DOWNLOAD_CACHE_TTL_MS = 2 * 60 * 1000;

const looksLikeMp4 = (buf: Buffer) => {
  if (!buf || buf.length < 12) return false;
  // ISO BMFF: [size(4)][ftyp(4)]
  return buf.subarray(4, 8).toString("ascii") === "ftyp";
};

const bufferReadable = async (props: {
  readable: AsyncIterable<Buffer>;
  maxBytes: number;
}): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of props.readable) {
    total += chunk.length;
    if (total > props.maxBytes) {
      throw new Error(
        `MP4 buffer exceeded maxBytes=${props.maxBytes} (total=${total})`,
      );
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
};

const getCachedDownloadedVideoclip = async (props: {
  cacheKey: string;
  download: () => Promise<Buffer>;
}): Promise<Buffer> => {
  const now = Date.now();
  const existing = videoclipDownloadCache.get(props.cacheKey);
  if (existing && now - existing.ts < VIDEOCLIP_DOWNLOAD_CACHE_TTL_MS) {
    return await existing.promise;
  }

  const promise = props.download();
  videoclipDownloadCache.set(props.cacheKey, { ts: now, promise });
  try {
    return await promise;
  } catch (e) {
    // Do not keep failed promises around.
    videoclipDownloadCache.delete(props.cacheKey);
    throw e;
  }
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
    baichuanRuntimePromise = import("@apocaliss92/reolink-baichuan-js") as any;
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
 * Handle video clip webhook request
 * Uses progressive streaming for immediate playback.
 * For iOS clients, uses HTTP download which is more compatible.
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
    ios.needsHls = ios.isIos && ios.isIosInstalledApp;
  }

  // iOS InstalledApp playback is most reliable via HLS.
  // If `?hls=` is present, always serve HLS assets (playlist/segments).
  const shouldUseHls = ios.needsHls || hlsPath !== undefined;

  // Legacy iOS InstalledApp MP4 path: Range probes (e.g. bytes=0-1) expect
  // a proper 206 with a total size in Content-Range.
  const hasRange = !!clientInfo.range;
  const preferDownloadForRange =
    !shouldUseHls && ios.isIosInstalledApp && hasRange;
  const useDownload = !shouldUseHls && ios.isIosInstalledApp && !hasRange;

  // These endpoints can be very chatty (HLS playlist polling + segment fetch).
  // Keep important transitions visible, but push repetitive per-request noise to debug.
  const requestMode = shouldUseHls
    ? "HLS"
    : useDownload
      ? "Download"
      : preferDownloadForRange
        ? "Download(Range)"
        : "Stream";
  const requestHlsPathForLog = shouldUseHls ? (hlsPath ?? "playlist.m3u8") : "";
  const isHlsSegmentReq =
    shouldUseHls && requestHlsPathForLog.toString().endsWith(".ts");
  const reqLogKey = `VideoClip:REQ:${props.deviceId}:${fileId}:${requestMode}:${requestHlsPathForLog}`;
  const reqLine = `[VideoClip] REQUEST: fileId=${fileId.slice(-40)}, isOnNvr=${device.isOnNvr}, isIos=${ios.isIos}, isIosInstalledApp=${ios.isIosInstalledApp}, hasRange=${hasRange}, hls=${shouldUseHls}, hlsPath=${JSON.stringify(hlsPath)}, hlsSocket=${hlsSocketMode}, mode=${requestMode}`;
  if (hasRange) {
    logger.log(reqLine);
  } else if (isHlsSegmentReq) {
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

    // Range support for iOS: serve a file-like response with known total size.
    // This is closer to the behavior in scrypted-advanced-notifier's sendVideo.
    if (preferDownloadForRange) {
      const rangeHeader = String(clientInfo.range).trim();
      const m = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader);
      if (!m) {
        response.send("Invalid Range", { code: 416 });
        return;
      }

      const start = Number.parseInt(m[1], 10);
      const endRaw = m[2];

      // Obtain an MP4 buffer (cached) so we can answer arbitrary byte ranges.
      // On some NVRs, downloadRecording() returns BcMedia/raw, not an MP4 file.
      // In that case, generate MP4 bytes via createRecordingDownloadMp4Stream.
      let fileBuf: Buffer;
      try {
        fileBuf = await getCachedDownloadedVideoclip({
          cacheKey: `${device.id || "device"}:${channel}:${fileId}`,
          download: async () => {
            logger.log(
              `[VideoClip] Range requested; preparing MP4 buffer for byte-range support: channel=${channel}, fileId=${fileId}`,
            );

            const rawOrMp4 = await api.downloadRecording({
              channel,
              fileName: fileId,
            });

            if (looksLikeMp4(rawOrMp4)) {
              return rawOrMp4;
            }

            logger.warn?.(
              `[VideoClip] downloadRecording did not look like MP4 (ftyp missing). Generating MP4 via createRecordingDownloadMp4Stream...`,
            );

            const { mp4, stop } = await api.createRecordingDownloadMp4Stream({
              channel,
              fileName: fileId,
            });

            try {
              const mp4Buf = await bufferReadable({
                readable: mp4 as any,
                maxBytes: 250 * 1024 * 1024,
              });

              if (!looksLikeMp4(mp4Buf)) {
                throw new Error(
                  "createRecordingDownloadMp4Stream output did not look like MP4 (ftyp missing)",
                );
              }

              return mp4Buf;
            } finally {
              await stop().catch(() => {});
            }
          },
        });
      } catch (e: any) {
        logger.error(
          `[VideoClip] Range download failed: ${e?.message || String(e)}`,
        );
        response.send(`Download failed: ${e?.message || "Unknown error"}`, {
          code: 500,
        });
        return;
      }

      const fileSize = fileBuf.length;
      const end = endRaw ? Number.parseInt(endRaw, 10) : fileSize - 1;
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end < start ||
        start >= fileSize
      ) {
        response.send("Invalid Range", { code: 416 });
        return;
      }

      const safeEnd = Math.min(end, fileSize - 1);
      const chunkSize = safeEnd - start + 1;
      const slice = fileBuf.subarray(start, safeEnd + 1);

      response.sendStream(
        (async function* () {
          // Yield in chunks to avoid large single-buffer writes.
          const CHUNK = 64 * 1024;
          for (let offset = 0; offset < slice.length; offset += CHUNK) {
            yield slice.subarray(
              offset,
              Math.min(offset + CHUNK, slice.length),
            );
          }
        })(),
        {
          code: 206,
          headers: {
            "Content-Range": `bytes ${start}-${safeEnd}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize.toString(),
            "Content-Type": "video/mp4",
            "Content-Disposition": 'inline; filename="clip.mp4"',
            "Cache-Control": "no-cache",
          },
        },
      );
      return;
    }

    if (useDownload) {
      // Download mode: use native Baichuan download (works for both NVR and standalone)
      logger.log(
        `[VideoClip] Starting native download: channel=${channel}, fileId=${fileId}`,
      );

      try {
        const mp4Buffer = await api.downloadRecording({
          channel,
          fileName: fileId,
        });

        logger.log(`[VideoClip] Downloaded: ${mp4Buffer.length} bytes`);

        // Send the buffer as a complete response in chunks
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
      } catch (downloadErr: any) {
        logger.error(
          `[VideoClip] Download failed: ${downloadErr?.message || String(downloadErr)}`,
        );
        response.send(
          `Download failed: ${downloadErr?.message || "Unknown error"}`,
          { code: 500 },
        );
        return;
      }
    }

    // Stream mode: use Baichuan streaming replay
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
