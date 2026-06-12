import type {
  BatteryInfo,
  DeviceCapabilities,
  NativeVideoStreamVariant,
  PtzCommand,
  PtzPreset,
  ReolinkBaichuanApi,
  ReolinkSimpleEvent,
  ReolinkSupportedStream,
  SleepStatus,
  StreamSamplingSelection,
} from "@apocaliss92/nodelink-js" with { "resolution-mode": "import" };
import sdk, {
  BinarySensor,
  Camera,
  ChargeState,
  Device,
  DeviceProvider,
  MediaObject,
  MediaStreamUrl,
  ObjectDetectionTypes,
  ObjectDetector,
  ObjectsDetected,
  PanTiltZoom,
  PanTiltZoomCommand,
  Reboot,
  RequestMediaStreamOptions,
  RequestPictureOptions,
  ResponsePictureOptions,
  ScryptedDeviceType,
  ScryptedInterface,
  ScryptedMimeTypes,
  Setting,
  Settings,
  VideoCamera,
  VideoClip,
  VideoClipOptions,
  VideoClips,
  VideoClipThumbnailOptions,
  VideoTextOverlay,
  VideoTextOverlays,
} from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Per-platform list of ffmpeg H.264 encoders we offer in the composite
 * settings dropdown. Mirrors `@scrypted/common/src/ffmpeg-hardware-
 * acceleration.ts`'s `getH264EncoderArgs()` but replicated here so we
 * don't take a build dependency on Scrypted's internal common package
 * (the subpath import doesn't resolve cleanly through the file-symlink
 * Scrypted plugins use). The shape mirrors the upstream helper exactly
 * so we can swap to the real one as soon as the resolution issue is
 * addressed upstream.
 *
 * Each value is the full `-c:v <encoder> [extra-args...]` arg list. The
 * code below pulls element [1] for the `-c:v` identifier and propagates
 * the rest through `extraOutputArgs`.
 */
function getCompositeH264EncoderArgs(): { [label: string]: string[] } {
  const args: { [label: string]: string[] } = {};
  const platform = os.platform();
  if (platform === "darwin") {
    args["VideoToolbox"] = ["-c:v", "h264_videotoolbox"];
  } else if (platform === "win32") {
    args["Intel QuickSync"] = ["-c:v", "h264_qsv"];
    args["AMD"] = ["-c:v", "h264_amf"];
    args["Nvidia"] = ["-c:v", "h264_nvenc"];
  } else if (platform === "linux") {
    args["V4L2 (Raspberry Pi)"] = [
      "-pix_fmt", "yuv420p",
      "-c:v", "h264_v4l2m2m",
    ];
    args["VAAPI"] = ["-c:v", "h264_vaapi"];
    args["Nvidia"] = ["-c:v", "h264_nvenc"];
  }
  args["libx264 (Software)"] = ["-c:v", "libx264"];
  return args;
}
import type { UrlMediaStreamOptions } from "../../scrypted/plugins/rtsp/src/rtsp";
import {
  ReolinkCameraAutotracking,
  ReolinkCameraChime,
  ReolinkCameraFloodlight,
  ReolinkCameraMotionFloodlight,
  ReolinkCameraMotionSiren,
  ReolinkCameraPirSensor,
  ReolinkCameraSiren,
} from "./accessories";
import {
  BaseBaichuanClass,
  type BaichuanConnectionCallbacks,
  type BaichuanConnectionConfig,
} from "./baichuan-base";
import { normalizeUid, type BaichuanTransport } from "./connect";
import {
  convertDebugLogsToApiOptions,
  getApiRelevantDebugLogs,
  getDebugLogChoices,
} from "./debug-options";
import { EMAIL_PUSH_SERVER_NATIVE_ID } from "./email-push-server-device";
import ReolinkNativePlugin from "./main";
import { ReolinkNativeMultiFocalDevice } from "./multiFocal";
import { ReolinkNativeNvrDevice } from "./nvr";
import { ReolinkPtzPresets } from "./presets";
import {
  createRfc4571MediaObjectFromStreamManager,
  selectStreamOption,
  StreamManager,
  StreamManagerOptions,
} from "./stream-utils";
import {
  autotrackingSuffix,
  chimeSuffix,
  floodlightSuffix,
  getDeviceInterfaces,
  getVideoClipWebhookUrls,
  motionFloodlightSuffix,
  motionSirenSuffix,
  pirSuffix,
  recordingsToVideoClips,
  removeAuthUrls,
  sirenSuffix,
  updateDeviceInfo,
} from "./utils";

export type CameraType =
  | "battery"
  | "regular"
  | "udp" // UDP camera without battery (e.g., Elite Floodlight WiFi)
  | "multi-focal"
  | "multi-focal-battery"
  | "multi-focal-udp"; // UDP multifocal without battery

export interface ReolinkCameraOptions {
  type: CameraType;
  nvrDevice?: ReolinkNativeNvrDevice; // Optional reference to NVR device
  multiFocalDevice?: ReolinkNativeMultiFocalDevice; // Optional reference to multi-focal device
}

export class ReolinkCamera
  extends BaseBaichuanClass
  implements
    VideoCamera,
    Camera,
    Settings,
    DeviceProvider,
    ObjectDetector,
    PanTiltZoom,
    VideoTextOverlays,
    BinarySensor,
    Reboot,
    VideoClips
{
  private readonly onSimpleEventBound = (ev: ReolinkSimpleEvent) =>
    this.onSimpleEvent(ev);

  storageSettings = new StorageSettings(this, {
    debugLogs: {
      title: "Debug logs",
      type: "boolean",
      immediate: true,
      onPut: async (ov, value) => {
        if (ov === value) return;
        const logger = this.getBaichuanLogger();
        if (this.resetBaichuanClient) {
          if (this.debugLogsResetTimeout) {
            clearTimeout(this.debugLogsResetTimeout);
            this.debugLogsResetTimeout = undefined;
          }
          this.debugLogsResetTimeout = setTimeout(async () => {
            this.debugLogsResetTimeout = undefined;
            try {
              await this.resetBaichuanClient("debugLogs changed");
              this.baichuanApi = undefined;
              this.ensureClientPromise = undefined;
              await this.ensureClient();
            } catch (e) {
              logger.warn(
                "Failed to reset client after debug logs change",
                e?.message || String(e),
              );
            }
          }, 2000);
        }
      },
    },
    // Basic connection settings
    ipAddress: {
      title: "IP Address",
      hide: false,
      type: "string",
      onPut: async () => {
        await this.credentialsChanged();
      },
    },
    username: {
      type: "string",
      hide: false,
      title: "Username",
      onPut: async () => {
        await this.credentialsChanged();
      },
    },
    password: {
      type: "password",
      hide: false,
      title: "Password",
      onPut: async () => {
        await this.credentialsChanged();
      },
    },
    rtspChannel: {
      type: "number",
      hide: true,
      defaultValue: 0,
    },
    variantType: {
      type: "string",
      hide: true,
      defaultValue: "default",
      choices: [
        "default",
        "autotrack",
        "telephoto",
      ] as NativeVideoStreamVariant[],
    },
    preferredStreams: {
      type: "string",
      title: "Preferred Stream Order",
      description:
        "Order preference for video streams. Default order varies by camera type.",
      defaultValue: "Default",
      choices: ["Default", "Native", "RTSP", "RTMP"],
    },
    multifocalInfo: {
      json: true,
      hide: true,
    },
    // Battery camera specific
    uid: {
      title: "UID",
      description: "Reolink UID (required for battery cameras / BCUDP).",
      type: "string",
      hide: true,
      onPut: async () => {
        await this.credentialsChanged();
      },
    },
    discoveryMethod: {
      title: "Discovery Method",
      description: "UDP discovery method for battery cameras (BCUDP).",
      type: "string",
      choices: ["local-direct", "local-broadcast", "remote", "map", "relay"],
      defaultValue: "local-direct",
      hide: true,
      subgroup: "Advanced",
      onPut: async () => {
        await this.credentialsChanged();
      },
    },
    mixinsSetup: {
      type: "boolean",
      hide: true,
    },
    // Regular camera specific
    dispatchEvents: {
      subgroup: "Advanced",
      title: "Dispatch Events",
      description:
        "Select which events to emit. Empty disables event subscription entirely.",
      multiple: true,
      combobox: true,
      immediate: true,
      defaultValue: ["motion", "objects"],
      choices: ["motion", "objects"],
      onPut: async () => {
        await this.subscribeToEvents();
      },
    },
    socketApiDebugLogs: {
      subgroup: "Advanced",
      title: "Socket API Debug Logs",
      description: "Enable specific debug logs.",
      multiple: true,
      combobox: true,
      immediate: true,
      defaultValue: [],
      choices: getDebugLogChoices(),
      onPut: async (ov, value) => {
        const logger = this.getBaichuanLogger();
        const oldApiOptions = getApiRelevantDebugLogs(ov || []);
        const newApiOptions = getApiRelevantDebugLogs(value || []);

        const oldSel = new Set(oldApiOptions);
        const newSel = new Set(newApiOptions);

        const changed =
          oldSel.size !== newSel.size ||
          Array.from(oldSel).some((k) => !newSel.has(k));
        if (changed && this.resetBaichuanClient) {
          // Clear any existing timeout
          if (this.debugLogsResetTimeout) {
            clearTimeout(this.debugLogsResetTimeout);
            this.debugLogsResetTimeout = undefined;
          }

          // Defer reset by 2 seconds to allow settings to settle
          this.debugLogsResetTimeout = setTimeout(async () => {
            this.debugLogsResetTimeout = undefined;
            try {
              await this.resetBaichuanClient("debugLogs changed");
              // Force reconnection with new debug options
              this.baichuanApi = undefined;
              this.ensureClientPromise = undefined;
              // Trigger reconnection
              await this.ensureClient();
            } catch (e) {
              logger.warn(
                "Failed to reset client after debug logs change",
                e?.message || String(e),
              );
            }
          }, 2000);
        }
      },
    },
    motionTimeout: {
      subgroup: "Advanced",
      title: "Motion Timeout",
      defaultValue: 20,
      type: "number",
    },
    cachedOsd: {
      multiple: true,
      hide: true,
      json: true,
      defaultValue: [],
    },
    // PTZ Presets
    presets: {
      group: "PTZ",
      title: "Presets to enable",
      description:
        'PTZ Presets in the format "id=name". Where id is the PTZ Preset identifier and name is a friendly name.',
      multiple: true,
      defaultValue: [],
      combobox: true,
      hide: true, // Will be shown if PTZ is supported
      onPut: async (ov, presets: string[]) => {
        const caps = {
          ...(this.ptzCapabilities || {}),
          presets: {},
        };
        for (const preset of presets) {
          const [key, name] = preset.split("=");
          caps.presets![key] = name;
        }
        this.ptzCapabilities = caps;
      },
      mapGet: () => {
        const presets = this.ptzCapabilities?.presets || {};
        return Object.entries(presets).map(([key, name]) => key + "=" + name);
      },
    },
    ptzMoveDurationMs: {
      title: "PTZ Move Duration (ms)",
      description:
        "How long a PTZ command moves before sending stop. Higher = more movement per click.",
      type: "number",
      defaultValue: 300,
      group: "PTZ",
      hide: true,
    },
    ptzZoomStep: {
      group: "PTZ",
      title: "PTZ Zoom Step",
      description:
        "How much to change zoom per zoom command (in zoom factor units, where 1.0 is normal).",
      type: "number",
      defaultValue: 0.1,
      hide: true,
    },
    ptzCreatePreset: {
      group: "PTZ",
      title: "Create Preset",
      description:
        "Enter a name and press Save to create a new PTZ preset at the current position.",
      type: "string",
      placeholder: "e.g. Door",
      defaultValue: "",
      hide: true,
      onPut: async (_ov, value) => {
        const name = String(value ?? "").trim();
        if (!name) {
          // Cleanup if user saved whitespace.
          if (String(value ?? "") !== "") {
            this.storageSettings.values.ptzCreatePreset = "";
          }
          return;
        }

        const logger = this.getBaichuanLogger();
        logger.log(`PTZ presets: create preset requested (name=${name})`);

        const preset = await this.withBaichuanRetry(async () => {
          await this.ensureClient();
          if (!this.ptzPresets) {
            throw new Error("PTZ presets not available");
          }
          return await this.ptzPresets.createPtzPreset(name);
        });
        const selection = `${preset.id}=${preset.name}`;

        // Auto-select created preset.
        this.storageSettings.values.ptzSelectedPreset = selection;
        this.storageSettings.values.ptzCreatePreset = "";

        logger.log(
          `PTZ presets: created preset id=${preset.id} name=${preset.name}`,
        );
      },
    },
    ptzSelectedPreset: {
      group: "PTZ",
      title: "Selected Preset",
      description: 'Select the preset to update or delete. Format: "id=name".',
      type: "string",
      combobox: false,
      immediate: true,
      hide: true,
    },
    ptzUpdateSelectedPreset: {
      group: "PTZ",
      title: "Update Selected Preset Position",
      description:
        "Overwrite the selected preset with the current PTZ position.",
      type: "button",
      immediate: true,
      hide: true,
      onPut: async () => {
        const presetId = this.getSelectedPresetId();
        if (presetId === undefined) {
          throw new Error("No preset selected");
        }

        const logger = this.getBaichuanLogger();
        logger.log(
          `PTZ presets: update position requested (presetId=${presetId})`,
        );

        await this.withBaichuanRetry(async () => {
          await this.ensureClient();
          return await this.ptzPresets.updatePtzPresetToCurrentPosition(
            presetId,
          );
        });
        logger.log(`PTZ presets: update position ok (presetId=${presetId})`);
      },
    },
    ptzDeleteSelectedPreset: {
      group: "PTZ",
      title: "Delete Selected Preset",
      description: "Delete the selected preset (firmware dependent).",
      type: "button",
      immediate: true,
      hide: true,
      onPut: async () => {
        const presetId = this.getSelectedPresetId();
        if (presetId === undefined) {
          throw new Error("No preset selected");
        }

        const logger = this.getBaichuanLogger();
        logger.log(`PTZ presets: delete requested (presetId=${presetId})`);

        await this.withBaichuanRetry(async () => {
          await this.ensureClient();
          return await this.ptzPresets.deletePtzPreset(presetId);
        });

        this.storageSettings.values.ptzSelectedPreset = "";
        logger.log(`PTZ presets: delete ok (presetId=${presetId})`);
      },
    },
    batteryUpdateIntervalMinutes: {
      title: "Battery Update Interval (minutes)",
      subgroup: "Advanced",
      description:
        "How often to wake up the camera and update battery status and snapshot (default: 60 minutes).",
      type: "number",
      defaultValue: 60,
      hide: true,
    },
    statusPollIntervalSeconds: {
      title: "Accessory Status Poll Interval (seconds)",
      subgroup: "Advanced",
      description:
        "How often to poll accessory device state (siren, floodlight, PIR, autotracking, chime) for wired cameras. 0 disables polling (push events still update state). Default: 60.",
      type: "number",
      defaultValue: 60,
      hide: true,
      onPut: async () => {
        this.restartStatusPoll();
      },
    },
    diagnosticsOutputPath: {
      title: "Diagnostics Output Path",
      subgroup: "Diagnostics",
      description:
        "Directory where diagnostics files will be saved (default: plugin volume).",
      type: "string",
      hide: true,
      defaultValue: path.join(
        process.env.SCRYPTED_PLUGIN_VOLUME,
        "diagnostics",
        this.name,
      ),
    },
    enableVideoclips: {
      title: "Enable Video Clips",
      group: "Videoclips",
      description:
        "Enable video clips functionality. If disabled, getVideoClips will return empty and all other videoclip settings are ignored.",
      type: "boolean",
      defaultValue: false,
      immediate: true,
      hide: true,
      onPut: async () => {
        this.updateVideoClipsAutoLoad();
      },
    },
    videoclipSource: {
      title: "Video Clips Source",
      group: "Videoclips",
      description:
        "Select the source for video clips: Native (Baichuan protocol) or HTTP (CGI API). HTTP may be more reliable on some devices.",
      type: "string",
      defaultValue: "Native",
      choices: ["Native", "HTTP"],
      immediate: true,
      hide: true,
    },
    videoclipStreamType: {
      title: "Video Clips Stream Type",
      group: "Videoclips",
      description:
        "Select the stream quality for video clips: main (higher quality) or sub (smaller files).",
      type: "string",
      defaultValue: "main",
      choices: ["main", "sub"],
      immediate: true,
      hide: true,
    },
    loadVideoclips: {
      title: "Auto-load Video Clips",
      group: "Videoclips",
      description:
        "Automatically fetch today's video clips and download missing thumbnails at regular intervals.",
      type: "boolean",
      defaultValue: false,
      immediate: true,
      hide: true,
      onPut: async () => {
        this.updateVideoClipsAutoLoad();
      },
    },
    videoclipsRegularChecks: {
      title: "Video Clips Check Interval (minutes)",
      group: "Videoclips",
      description:
        "How often to check for new video clips and download thumbnails (default: 30 minutes).",
      type: "number",
      defaultValue: 30,
      hide: true,
      onPut: async () => {
        this.updateVideoClipsAutoLoad();
      },
    },
    downloadVideoclipsLocally: {
      title: "Download Video Clips Locally",
      group: "Videoclips",
      description:
        "Automatically download and cache video clips to local filesystem during auto-load.",
      type: "boolean",
      defaultValue: false,
      immediate: true,
      hide: true,
      onPut: async () => {
        this.updateVideoClipsAutoLoad();
      },
    },
    videoclipsDaysToPreload: {
      title: "Days to Preload",
      group: "Videoclips",
      description:
        "Number of days to preload video clips and thumbnails (default: 1, only today).",
      type: "number",
      defaultValue: 3,
      hide: true,
      onPut: async () => {
        this.updateVideoClipsAutoLoad();
      },
    },
    videoclipsHighWaterMark: {
      // Internal: epoch ms of the most recent clip fully processed by the
      // auto-load run. Subsequent runs start from this mark (minus a small
      // overlap) instead of re-scanning the whole preload window every time.
      // 0 means "no successful run yet" (full backfill).
      type: "number",
      defaultValue: 0,
      hide: true,
      readonly: true,
    },
    clearVideoclipsCache: {
      title: "Clear All Video Clips Cache",
      group: "Videoclips",
      description:
        "Delete all cached video clips and thumbnails from local storage. This will free up disk space but clips will need to be re-downloaded when accessed.",
      type: "button",
      immediate: true,
      onPut: async () => {
        await this.clearAllVideoclipsCache();
      },
    },
    userSessions: {
      title: "Active User Sessions",
      subgroup: "Sessions",
      description:
        "List of currently active user sessions connected to the device via Baichuan socket. Click 'Refresh Sessions' to update.",
      type: "string",
      multiple: true,
      combobox: false,
      readonly: true,
      hide: true,
      defaultValue: [],
    },
    refreshUserSessions: {
      title: "Refresh Sessions",
      subgroup: "Sessions",
      description: "Refresh the list of active user sessions from the device.",
      type: "button",
      immediate: true,
      hide: true,
      onPut: async () => {
        await this.refreshUserSessionsList();
      },
    },
    diagnosticsRun: {
      subgroup: "Diagnostics",
      title: "Run Diagnostics",
      description: "Run all diagnostics and save results to the output path.",
      type: "button",
      hide: true,
      immediate: true,
      onPut: async () => {
        await this.runDiagnostics();
      },
    },
    dumpModelFixtures: {
      subgroup: "Diagnostics",
      title: "Dump Model Fixtures",
      description:
        "Capture all API responses for this device and save as fixture files. " +
        "Useful for regression testing and debugging capability detection.",
      type: "button",
      immediate: true,
      onPut: async () => {
        await this.dumpModelFixtures();
      },
    },
    // Multifocal composite stream PIP settings
    pipPosition: {
      title: "PIP Position",
      description: "Position of the tele lens overlay on the wider lens view",
      type: "string",
      defaultValue: "bottom-right",
      group: "Composite stream",
      choices: [
        "top-left",
        "top-right",
        "bottom-left",
        "bottom-right",
        "center",
        "top-center",
        "bottom-center",
        "left-center",
        "right-center",
      ],
      hide: true, // Only show for multifocal devices via getAdditionalSettings
    },
    pipSize: {
      title: "PIP Size",
      description:
        "Relative size of the PIP overlay (0.1 = 10%, 0.3 = 30%, etc.)",
      type: "number",
      defaultValue: 0.25,
      group: "Composite stream",
      hide: true,
      onPut: async () => {
        this.scheduleStreamManagerRestart("pipSize changed");
      },
    },
    pipMargin: {
      title: "PIP Margin",
      description:
        "Margin from edge as a fraction of the output size (e.g. 0.01 = 1%). Values > 1 are treated as pixels (legacy).",
      type: "number",
      defaultValue: 0.01,
      group: "Composite stream",
      hide: true,
      onPut: async () => {
        this.scheduleStreamManagerRestart("pipMargin changed");
      },
    },

    compositeAssumeH264: {
      title: "Composite: Assume H.264 Inputs",
      description:
        "Assume both wider+tele inputs are H.264 (skips codec detection). Recommended when using sub+sub on TrackMix. If inputs are actually H.265, the composite may fail to start.",
      type: "boolean",
      defaultValue: true,
      group: "Composite stream",
      hide: true,
      onPut: async () => {
        this.scheduleStreamManagerRestart("compositeAssumeH264 changed");
      },
    },
    compositeDisableTranscode: {
      title: "Composite: Disable Codec Transcode (Best-effort)",
      description:
        "Best-effort knob. Overlay requires re-encode in ffmpeg; this option only avoids HEVC->H264 codec assumptions when possible. Leave off unless you know what you are doing.",
      type: "boolean",
      defaultValue: false,
      group: "Composite stream",
      hide: true,
      onPut: async () => {
        this.scheduleStreamManagerRestart("compositeDisableTranscode changed");
      },
    },
    // ─── Composite ffmpeg tuning ─────────────────────────────────
    // Encoder + quality knobs. Defaults preserve the previous behavior
    // (libx264 / ultrafast / crf 23 / 1s GOP). Switching the encoder
    // away from libx264 is the single biggest perf win — try the HW
    // encoder for your host: h264_videotoolbox (macOS), h264_qsv or
    // h264_vaapi (Intel/AMD), h264_nvenc (NVIDIA), h264_v4l2m2m
    // (Raspberry Pi). When you change the encoder the libx264-specific
    // preset/CRF knobs are silently dropped — use "Composite: extra
    // output args" to pass the encoder's own options.
    // Encoder choices come straight from Scrypted's per-platform
    // hardware-acceleration helper, so the dropdown only ever offers
    // encoders that ffmpeg on this host actually supports — Mac sees
    // VideoToolbox, Windows sees QuickSync/AMD/Nvidia, Linux sees
    // V4L2/VAAPI/Nvidia, Raspberry Pi sees its dedicated V4L2 path.
    // The displayed label is human-readable ("VideoToolbox",
    // "Intel QuickSync", "libx264 (Software)") and the actual ffmpeg
    // `-c:v` identifier is resolved at use time via
    // `resolveCompositeVideoEncoder()` below.
    compositeVideoEncoder: {
      title: "Composite: ffmpeg encoder",
      description:
        "Output video encoder. Choices are limited to what ffmpeg supports on this host. Hardware encoders typically reduce CPU 5-10× vs libx264.",
      type: "string",
      defaultValue: "libx264 (Software)",
      group: "Composite stream",
      hide: true,
      choices: Object.keys(getCompositeH264EncoderArgs()),
      onPut: async () => {
        this.scheduleStreamManagerRestart("compositeVideoEncoder changed");
      },
    },
    compositeEncoderPreset: {
      title: "Composite: libx264 preset",
      description:
        "Only used when encoder is libx264. ultrafast = least CPU / worst compression; placebo = the opposite. Default ultrafast.",
      type: "string",
      defaultValue: "ultrafast",
      group: "Composite stream",
      hide: true,
      choices: [
        "ultrafast",
        "superfast",
        "veryfast",
        "faster",
        "fast",
        "medium",
        "slow",
        "slower",
        "veryslow",
        "placebo",
      ],
      onPut: async () => {
        this.scheduleStreamManagerRestart("compositeEncoderPreset changed");
      },
    },
    compositeCrf: {
      title: "Composite: libx264 CRF (quality)",
      description:
        "Only used when encoder is libx264. 0 = lossless (huge), 23 = visually lossless, 51 = worst. Drop by 2 to roughly halve bitrate at the same quality.",
      type: "number",
      defaultValue: 23,
      group: "Composite stream",
      hide: true,
      onPut: async () => {
        this.scheduleStreamManagerRestart("compositeCrf changed");
      },
    },
    compositeGopSeconds: {
      title: "Composite: keyframe interval (seconds)",
      description:
        "Lower = faster mid-stream join + larger stream; higher = better compression + slower join. Default 1s.",
      type: "number",
      defaultValue: 1,
      group: "Composite stream",
      hide: true,
      onPut: async () => {
        this.scheduleStreamManagerRestart("compositeGopSeconds changed");
      },
    },
    compositeExtraGlobalArgs: {
      title: "Composite: extra global args",
      description:
        "Free-form ffmpeg args inserted BEFORE the inputs. Use for hardware decode hints, e.g. \"-hwaccel videotoolbox\" or \"-hwaccel qsv -qsv_device /dev/dri/renderD128\". Whitespace-separated. Invalid args WILL crash ffmpeg.",
      type: "string",
      defaultValue: "",
      group: "Composite stream",
      hide: true,
      onPut: async () => {
        this.scheduleStreamManagerRestart("compositeExtraGlobalArgs changed");
      },
    },
    compositeExtraOutputArgs: {
      title: "Composite: extra output args",
      description:
        "Free-form ffmpeg args inserted JUST BEFORE the output. Use for encoder-specific options when encoder ≠ libx264, e.g. \"-q:v 23\" (qsv) or \"-preset fast -rc cbr\" (nvenc). Whitespace-separated. Invalid args WILL crash ffmpeg.",
      type: "string",
      defaultValue: "",
      group: "Composite stream",
      hide: true,
      onPut: async () => {
        this.scheduleStreamManagerRestart("compositeExtraOutputArgs changed");
      },
    },
    // ─── E-mail Push ─────────────────────────────────────────────
    // Per-camera knobs that pair with the singleton
    // `Reolink E-mail Push Server` device. Hidden by default and
    // un-hidden in `init()` only for standalone cameras (NVR-attached
    // children share the NVR's mail path and would silently fail).
    emailPushCachedStatus: {
      group: "E-mail Push",
      title: "Camera-side SMTP target",
      description:
        "Last read of the camera's own SMTP config (smtpServer / recipient). Click Refresh to update — reading wakes battery cameras, so we don't auto-refresh.",
      type: "string",
      readonly: true,
      defaultValue: "(not loaded yet — click Refresh status below)",
      hide: true,
    },
    emailPushTriggers: {
      group: "E-mail Push",
      title: "Trigger events",
      description:
        "Event types whose schedule will be flipped to 24/7 ON when Auto-configure is applied. MD = generic motion.",
      type: "string",
      multiple: true,
      combobox: true,
      defaultValue: ["MD", "people", "vehicle"],
      choices: ["MD", "people", "vehicle"],
      hide: true,
    },
    emailPushAttachment: {
      group: "E-mail Push",
      title: "Attachment",
      description:
        "What the camera attaches when it sends an alert. `picture` is recommended — it lets the manager publish the snapshot to MQTT image entities.",
      type: "string",
      defaultValue: "picture",
      choices: ["picture", "video", "none"],
      immediate: true,
      hide: true,
    },
    emailPushAutoConfigure: {
      group: "E-mail Push",
      title: "Auto-configure from Email Push Server",
      description:
        "Reads host/port/auth/domain from the singleton server device and pushes the matching SMTP + schedule to this camera. Open the Reolink E-mail Push Server device once first so it bootstraps.",
      type: "button",
      hide: true,
      onPut: async () => {
        await this.autoConfigureEmailPushFromServer();
      },
    },
    emailPushTest: {
      group: "E-mail Push",
      title: "Send test e-mail",
      description:
        "Asks the camera to perform a live SMTP send against its currently saved target. Can take up to 60s; returns success/failure.",
      type: "button",
      hide: true,
      onPut: async () => {
        await this.runEmailPushTest();
      },
    },
    emailPushRefreshStatus: {
      group: "E-mail Push",
      title: "Refresh status",
      description:
        "Reads the current camera-side SMTP config and updates the status row above. Wakes battery cameras.",
      type: "button",
      hide: true,
      onPut: async () => {
        await this.refreshEmailPushStatus();
      },
    },
  });

  ptzPresets = new ReolinkPtzPresets(this);
  refreshingState = false;
  classes: string[] = [];
  presets: PtzPreset[] = [];
  streamManager?: StreamManager;

  motionSiren?: ReolinkCameraMotionSiren;
  siren?: ReolinkCameraSiren;
  motionFloodlight?: ReolinkCameraMotionFloodlight;
  floodlight?: ReolinkCameraFloodlight;
  pirSensor?: ReolinkCameraPirSensor;
  autotracking?: ReolinkCameraAutotracking;
  chime?: ReolinkCameraChime;

  private lastPicture: { mo: MediaObject; atMs: number } | undefined;
  private takePictureInFlight: Promise<MediaObject> | undefined;
  forceNewSnapshot: boolean = false;

  public cachedCapabilities: DeviceCapabilities | undefined;

  // Video stream properties
  protected cachedVideoStreamOptions?: UrlMediaStreamOptions[];
  protected fetchingStreamsPromise:
    | Promise<UrlMediaStreamOptions[]>
    | undefined;
  protected lastNetPortCacheAttempt: number = 0;
  protected netPortCacheBackoffMs: number = 5000; // 5 seconds backoff on failure

  // Client management (inherited from BaseBaichuanClass)
  private debugLogsResetTimeout: NodeJS.Timeout | undefined;

  motionTimeout?: NodeJS.Timeout;
  doorbellBinaryTimeout?: NodeJS.Timeout;

  protected nvrDevice?: ReolinkNativeNvrDevice;
  protected multiFocalDevice?: ReolinkNativeMultiFocalDevice;
  thisDevice: Settings;
  isBattery: boolean;
  isUdpCamera: boolean; // UDP camera without battery (e.g., Elite Floodlight WiFi)
  isMultiFocal: boolean;
  isOnNvr: boolean;
  protocol: BaichuanTransport;
  private streamManagerRestartTimeout: NodeJS.Timeout | undefined;
  private videoClipsAutoLoadInterval: NodeJS.Timeout | undefined;
  private videoClipsAutoLoadInProgress: boolean = false;

  private batteryUpdatePromise: Promise<void> | undefined;
  private sleepCheckTimer: NodeJS.Timeout | undefined;
  private batteryUpdateTimer: NodeJS.Timeout | undefined;
  private periodicStarted = false;
  private statusPollTimer: NodeJS.Timeout | undefined;
  // Off-handle for the global email-push bus subscription. Tied to
  // the camera (Scrypted device) lifecycle, NOT to the Baichuan api
  // — the plugin destroys the api on every idle_disconnect (battery
  // cams every ~30s), and an api-scoped bridge would be dead in
  // that window. The camera-scoped subscription stays alive across
  // every reconnect cycle so SMTP motion always finds a listener.
  private emailPushBusOff?: () => void;

  // Cooldown timestamps to prevent alignAuxDevicesState from overwriting recently set states
  // Camera can take 10+ seconds to reflect state changes in its API response
  auxDeviceCooldowns: {
    motionSiren?: number;
    siren?: number;
    motionFloodlight?: number;
    floodlight?: number;
    pir?: number;
    autotracking?: number;
    chime?: number;
  } = {};

  constructor(
    nativeId: string,
    public plugin: ReolinkNativePlugin,
    public options: ReolinkCameraOptions,
  ) {
    const isBattery =
      options.type === "battery" || options.type === "multi-focal-battery";
    // UDP cameras include: battery cameras, NVR children, and UDP-only cameras (e.g., Elite Floodlight WiFi)
    const isUdpCamera =
      options.type === "udp" || options.type === "multi-focal-udp";
    const transport = isBattery || isUdpCamera ? "udp" : "tcp";
    // const transport =
    //   isBattery || isUdpCamera || !!options.nvrDevice ? "udp" : "tcp";
    super(nativeId, transport);
    this.plugin.camerasMap.set(this.id, this);

    // Store NVR device reference if provided
    this.nvrDevice = options.nvrDevice;
    this.multiFocalDevice = options.multiFocalDevice;
    this.thisDevice = sdk.systemManager.getDeviceById<Settings>(this.id);

    this.isBattery = isBattery;
    this.isUdpCamera = isUdpCamera; // UDP camera without battery (e.g., Elite Floodlight WiFi)
    this.isMultiFocal =
      options.type === "multi-focal" ||
      options.type === "multi-focal-battery" ||
      options.type === "multi-focal-udp";
    this.isOnNvr = !!this.nvrDevice || !!this.multiFocalDevice?.nvrDevice;
    this.protocol = transport;

    setTimeout(async () => {
      if (this.motionDetected) {
        this.motionDetected = false;
      }

      await this.init();
    }, 2000);
  }

  protected async withBaichuanClient<T>(
    fn: (api: ReolinkBaichuanApi) => Promise<T>,
  ): Promise<T> {
    const client = await this.ensureClient();
    return fn(client);
  }

  async getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]> {
    // Check if videoclips are enabled
    if (!this.storageSettings.values.enableVideoclips) {
      return [];
    }

    if (this.multiFocalDevice) {
      return this.multiFocalDevice.getVideoClips(options);
    }

    const isSleeping = !this.nvrDevice && this.isBattery && this.sleeping;

    // Skip sleeping check during auto-load to allow auto-load to start for battery cameras
    if (!this.videoClipsAutoLoadInProgress && isSleeping) {
      const logger = this.getBaichuanLogger();
      logger.debug("getVideoClips: disabled for battery devices");
      return [];
    }

    const logger = this.getBaichuanLogger();

    // Determine time window
    const nowMs = Date.now();
    const defaultWindowMs = 60 * 60 * 1000; // last 60 minutes

    const startMs = options?.startTime ?? nowMs - defaultWindowMs;
    let endMs = options?.endTime ?? nowMs;
    const count = options?.count;

    if (endMs > nowMs) {
      endMs = nowMs;
    }

    if (endMs <= startMs) {
      logger.warn("getVideoClips: invalid time window, endTime <= startTime", {
        startTime: startMs,
        endTime: endMs,
      });
      return [];
    }

    const start = new Date(startMs);
    const end = new Date(endMs);
    start.setHours(0, 0, 0, 0);

    // Ensure end is at 23:59:59 of the same day for proper day-based queries
    // Reolink cameras organize recordings per-day, so we need to query within a single day
    const endOfDay = new Date(end);
    endOfDay.setHours(23, 59, 59, 999);

    // If end is exactly at midnight (00:00:00), it means the previous day's end
    // In this case, we should query the previous day ending at 23:59:59
    if (
      end.getHours() === 0 &&
      end.getMinutes() === 0 &&
      end.getSeconds() === 0
    ) {
      // end is at midnight, move back 1ms to get 23:59:59 of the previous day
      end.setTime(end.getTime() - 1);
    } else if (endOfDay.getTime() <= nowMs) {
      end.setTime(endOfDay.getTime());
    }

    try {
      const api = await this.ensureClient();
      const channel = this.storageSettings.values.rtspChannel ?? 0;
      const useHttpSource =
        this.storageSettings.values.videoclipSource === "HTTP";

      logger.debug(
        `[getVideoClips] Listing recordings: channel=${channel}, start=${start.toISOString()}, end=${end.toISOString()}, source=${useHttpSource ? "HTTP" : "Native"}`,
      );

      // Use HTTP CGI API or native Baichuan API based on videoclipSource setting
      const streamTypeSetting =
        this.storageSettings.values.videoclipStreamType || "main";
      // Map "main"/"sub" to native Baichuan stream type names
      const nativeStreamType =
        streamTypeSetting === "sub" ? "subStream" : "mainStream";

      let recordings;
      if (useHttpSource) {
        // HTTP mode: use CGI API
        recordings = await api.getVideoclipsCgi({
          channel,
          start,
          end,
          streamType: streamTypeSetting,
          autoSearchByDay: true,
        });
      } else {
        // Native mode: use Baichuan protocol
        recordings = await api.getVideoclips({
          channel,
          start,
          end,
          streamType: nativeStreamType,
        });
      }

      // Convert VOD recordings to VideoClip array using the shared parser
      const clips = await recordingsToVideoClips(recordings, {
        logger,
        plugin: this,
        deviceId: this.id,
        count,
      });

      logger.debug(
        `[getVideoClips] Converted ${clips.length} video clips (limit: ${count || "none"})`,
      );

      return clips;
    } catch (e: any) {
      const message = e instanceof Error ? e.message : String(e);

      if (message?.includes("UID is required to access recordings")) {
        logger.log(
          "getVideoClips: recordings not available or UID not resolvable for this device",
          {
            error: message,
          },
        );
      } else {
        logger.warn("getVideoClips: failed to list recordings", {
          error: message,
        });
      }
      return [];
    }
  }

  /**
   * Get the cache directory for video clips and thumbnails
   */
  private getVideoClipCacheDir(): string {
    const pluginVolume = process.env.SCRYPTED_PLUGIN_VOLUME || "";
    const cameraId = this.id;
    return path.join(pluginVolume, "videoclips", cameraId);
  }

  /**
   * Get cache file path for a video clip
   */
  getVideoClipCachePath(videoId: string): string {
    // Create a safe filename from videoId using hash
    const hash = crypto.createHash("md5").update(videoId).digest("hex");
    // Keep original extension if present, otherwise use .mp4
    const ext = videoId.includes(".") ? path.extname(videoId) : ".mp4";
    const cacheDir = this.getVideoClipCacheDir();
    return path.join(cacheDir, `${hash}${ext}`);
  }

  async getVideoClip(videoId: string): Promise<MediaObject> {
    const logger = this.getBaichuanLogger();
    try {
      // Use webhook URL - this will be handled by handleVideoClipRequest in main.ts
      // which provides progressive streaming with caching
      logger.log(`[VideoClip] Getting webhook URL: ${videoId.slice(-40)}`);

      const { videoUrl } = await getVideoClipWebhookUrls({
        deviceId: this.id,
        fileId: videoId,
        plugin: this,
        logger,
      });

      logger.log(`[VideoClip] Webhook URL ready: ${videoUrl.slice(0, 80)}...`);

      // Create MediaObject from webhook URL
      const mo = await sdk.mediaManager.createMediaObjectFromUrl(videoUrl);

      return mo;
    } catch (e) {
      logger.error(
        `getVideoClip: failed to get video clip ${videoId}`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  /**
   * Get the cache directory for thumbnails (same as video clips)
   */
  private getThumbnailCacheDir(): string {
    // Use the same directory as video clips
    return this.getVideoClipCacheDir();
  }

  /**
   * Get cache file path for a thumbnail
   */
  private getThumbnailCachePath(fileId: string): string {
    // Use the same hash and base name as video clips, but with .jpg extension
    const hash = crypto.createHash("md5").update(fileId).digest("hex");
    const cacheDir = this.getThumbnailCacheDir();
    return path.join(cacheDir, `${hash}.jpg`);
  }

  async getVideoClipThumbnail(
    thumbnailId: string,
    options?: VideoClipThumbnailOptions,
  ): Promise<MediaObject> {
    if (this.multiFocalDevice) {
      return this.multiFocalDevice.getVideoClipThumbnail(thumbnailId, options);
    }

    const logger = this.getBaichuanLogger();

    try {
      // Check cache first
      const cachePath = this.getThumbnailCachePath(thumbnailId);
      const cacheDir = this.getThumbnailCacheDir();
      const MIN_THUMB_CACHE_BYTES = 512; // 0.5KB, evita file vuoti o quasi

      try {
        await fs.promises.access(cachePath, fs.constants.F_OK);
        const stats = await fs.promises.stat(cachePath);
        if (stats.size < MIN_THUMB_CACHE_BYTES) {
          logger.warn(
            `[Thumbnail] Cached thumbnail too small, deleting and regenerating: fileId=${thumbnailId}, size=${stats.size} bytes`,
          );
          try {
            await fs.promises.unlink(cachePath);
          } catch (unlinkErr) {
            logger.warn(
              `[Thumbnail] Failed to delete small cached thumbnail: fileId=${thumbnailId}`,
              unlinkErr?.message || String(unlinkErr),
            );
          }
        } else {
          logger.debug(
            `[Thumbnail] Using cached: fileId=${thumbnailId}, size=${stats.size} bytes`,
          );
          // Return cached thumbnail as MediaObject
          const mo = await sdk.mediaManager.createMediaObjectFromUrl(
            `file://${cachePath}`,
          );
          return mo;
        }
      } catch {
        // File doesn't exist, need to generate it
        logger.debug(`[Thumbnail] Cache miss: fileId=${thumbnailId}`);
      }

      // Ensure cache directory exists
      await fs.promises.mkdir(cacheDir, { recursive: true });

      // NVR mode: `thumbnailId` is expected to be a full recording path (e.g. /mnt/sda/...).
      // Use the same ffmpeg-based thumbnail extraction flow as other sources.

      // Check if video clip is already cached locally - use it instead of calling camera
      const videoCachePath = this.getVideoClipCachePath(thumbnailId);
      let useLocalVideo = false;
      try {
        await fs.promises.access(videoCachePath, fs.constants.F_OK);
        useLocalVideo = true;
        logger.debug(
          `[Thumbnail] Using local video file for thumbnail extraction: fileId=${thumbnailId}`,
        );
      } catch {
        // Video not cached locally, will use native API
      }

      let thumbnail: MediaObject;

      if (useLocalVideo) {
        // Extract thumbnail from local video file using ffmpeg
        const ffmpegPath = await sdk.mediaManager.getFFmpegPath();
        const mo = await sdk.mediaManager.createFFmpegMediaObject({
          inputArguments: ["-ss", "00:00:01", "-i", videoCachePath],
        });
        thumbnail = mo;
      } else {
        const api = await this.ensureClient();
        const channel = this.storageSettings.values.rtspChannel ?? 0;
        const ffmpegPath = await sdk.mediaManager.getFFmpegPath();
        const useHttpSource =
          this.storageSettings.values.videoclipSource === "HTTP";

        if (useHttpSource) {
          // HTTP mode: use CGI API with ffmpeg to extract thumbnail from VOD stream
          logger.debug(
            `[Thumbnail] Using CGI API (HTTP): fileId=${thumbnailId}`,
          );

          const jpegBuffer = await api.getVideoclipThumbnailJpegCgi({
            channel,
            filename: thumbnailId,
            ffmpegPath,
            timeoutMs: 30000,
            seekSeconds: 0,
          });

          thumbnail = await sdk.mediaManager.createMediaObject(
            jpegBuffer,
            "image/jpeg",
          );
        } else {
          // Native mode: use Baichuan CoverPreview API (cmd_id=298) - fast thumbnail extraction
          // Dynamic import to avoid CommonJS/ESM issues
          const { parseRecordingFileName } =
            await import("@apocaliss92/nodelink-js");

          // Parse filename to extract start time for CoverPreview
          const parsed = parseRecordingFileName(thumbnailId);
          if (!parsed?.start) {
            throw new Error(
              `[Thumbnail] Cannot parse recording filename to extract timestamp: ${thumbnailId}`,
            );
          }

          logger.debug(
            `[Thumbnail] Using CoverPreview API (Native): fileId=${thumbnailId}, startTime=${parsed.start.toISOString()}`,
          );

          // Use getVideoclipThumbnailJpeg which uses CoverPreview (cmd_id=298)
          // This is faster than getRecordingThumbnail which starts a replay stream
          // For NVR devices, we need to pass isNvr=true to include UID in the request
          const jpegBuffer = await api.getVideoclipThumbnailJpeg({
            channel,
            time: parsed.start,
            endTime: parsed.end,
            snapType: "sub",
            ffmpegPath,
            isNvr: this.isOnNvr,
          });

          thumbnail = await sdk.mediaManager.createMediaObject(
            jpegBuffer,
            "image/jpeg",
          );
        }
      }

      // Cache the thumbnail
      try {
        const buffer = await sdk.mediaManager.convertMediaObjectToBuffer(
          thumbnail,
          "image/jpeg",
        );
        await fs.promises.writeFile(cachePath, buffer);
        logger.debug(
          `[Thumbnail] Cached: fileId=${thumbnailId}, size=${buffer.length} bytes`,
        );
      } catch (e) {
        logger.warn(
          `[Thumbnail] Failed to cache: fileId=${thumbnailId}`,
          e?.message || String(e),
        );
        // Continue even if caching fails
      }

      return thumbnail;
    } catch (e) {
      logger.error(
        `[Thumbnail] Error: fileId=${thumbnailId}`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  /**
   * Get a playback URL for a video clip file.
   * Handles both NVR source (full path) and Device source (filename only).
   *
   * Historically this returned RTMP for standalone cameras, but many devices work best
   * with the HTTP VOD Download endpoint.
   *
   * @param fileId - The file ID or full path
   * @param forThumbnail - If true, prefer Download over Playback (better for ffmpeg thumbnail extraction)
   */
  async getVideoClipPlaybackUrl(
    fileId: string,
    forThumbnail: boolean = false,
  ): Promise<string> {
    const logger = this.getBaichuanLogger();
    const useNvr = !!this.nvrDevice;

    if (useNvr) {
      // NVR mode: `fileId` is expected to be a full recording path (e.g. /mnt/sda/...).
      logger.debug(
        `[getVideoClipRtmpUrl] Using NVR VOD API for fileId="${fileId}"`,
      );
      const api = await this.ensureClient();

      const channel = this.storageSettings.values.rtspChannel ?? 0;
      try {
        const url = await api.getVodUrl(fileId, channel, {
          requestType: "Download",
          streamType: "main",
        });
        if (url) return url;
      } catch (e: any) {
        logger.error(
          `[getVideoClipRtmpUrl] getVodUrl Download failed: ${e?.message || String(e)}`,
        );
      }

      throw new Error(
        `No streaming URL found from NVR for file ${fileId} after trying Playback and Download methods`,
      );
    } else {
      // Camera standalone: prefer HTTP Download when possible (more reliable than RTMP on many firmwares).
      logger.debug(
        `[getVideoClipRtmpUrl] Getting VOD URL for fileId="${fileId}" (camera standalone)`,
      );
      const api = await this.ensureClient();

      const channel = this.storageSettings.values.rtspChannel ?? 0;

      // 1) Try HTTP VOD Download.
      try {
        const requestType = forThumbnail ? "Download" : "Download";
        const url = await api.getVodUrl(fileId, channel, {
          requestType,
          streamType: "main",
          // Standalone cameras do not need NVR download preparation.
          prepare: false,
        });
        if (url?.startsWith("http://") || url?.startsWith("https://")) {
          logger.debug(
            `[getVideoClipRtmpUrl] HTTP VOD URL selected: url="${url}"`,
          );
          return url;
        }
      } catch (e: any) {
        logger.debug(
          `[getVideoClipRtmpUrl] getVodUrl Download failed (standalone): ${e?.message || String(e)}`,
        );
      }

      // 2) Fallback to Baichuan RTMP.
      const result = await api.getRecordingPlaybackUrls({ fileName: fileId });
      logger.debug(
        `[getVideoClipRtmpUrl] Baichuan RTMP URL received: rtmpVodUrl="${result.rtmpVodUrl || "none"}"`,
      );
      if (!result.rtmpVodUrl) {
        throw new Error(
          `No RTMP URL found from Baichuan API for file ${fileId}`,
        );
      }
      return result.rtmpVodUrl;
    }
  }

  /** @deprecated Use getVideoClipPlaybackUrl. */
  async getVideoClipRtmpUrl(
    fileId: string,
    forThumbnail: boolean = false,
  ): Promise<string> {
    return this.getVideoClipPlaybackUrl(fileId, forThumbnail);
  }

  removeVideoClips(...videoClipIds: string[]): Promise<void> {
    throw new Error("removeVideoClips is not implemented yet.");
  }

  /**
   * Refresh the list of active user sessions from the device
   */
  async refreshUserSessionsList(): Promise<void> {
    return super.refreshUserSessionsList();
  }

  /**
   * Clear all cached video clips and thumbnails from local storage
   */
  async clearAllVideoclipsCache(): Promise<void> {
    const logger = this.getBaichuanLogger();
    const cacheDir = this.getVideoClipCacheDir();

    try {
      // Check if directory exists
      try {
        await fs.promises.access(cacheDir, fs.constants.F_OK);
      } catch {
        logger.log(`[VideoClips] Cache directory does not exist: ${cacheDir}`);
        return;
      }

      // Calculate total size before deletion
      let totalSize = 0;
      let fileCount = 0;

      const calculateSize = async (dir: string): Promise<void> => {
        const entries = await fs.promises.readdir(dir, {
          withFileTypes: true,
        });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          try {
            if (entry.isDirectory()) {
              await calculateSize(fullPath);
            } else {
              const stats = await fs.promises.stat(fullPath);
              totalSize += stats.size;
              fileCount++;
            }
          } catch (e) {
            // Ignore errors during size calculation
          }
        }
      };

      await calculateSize(cacheDir);

      // Delete the entire cache directory recursively
      await fs.promises.rm(cacheDir, { recursive: true, force: true });

      // Recreate the cache directory for future use
      await fs.promises.mkdir(cacheDir, { recursive: true });

      // Reset the auto-load high-water mark so the next run does a full
      // backfill over the configured preload window (the cache is now empty).
      this.storageSettings.values.videoclipsHighWaterMark = 0;

      const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);
      logger.log(
        `[VideoClips] Cache cleared: ${fileCount} files, ${sizeMB} MB freed. Cache directory recreated.`,
      );
    } catch (e) {
      logger.error(
        `[VideoClips] Failed to clear cache: ${e?.message || String(e)}`,
      );
      throw e;
    }
  }

  /**
   * Update video clips auto-load timer based on settings
   */
  private updateVideoClipsAutoLoad(): void {
    // Clear existing interval if any
    if (this.videoClipsAutoLoadInterval) {
      clearInterval(this.videoClipsAutoLoadInterval);
      this.videoClipsAutoLoadInterval = undefined;
    }

    // Check if videoclips are enabled at all
    const { enableVideoclips, loadVideoclips, videoclipsRegularChecks } =
      this.storageSettings.values;
    if (!enableVideoclips) {
      return;
    }

    if (!loadVideoclips) {
      return;
    }

    const logger = this.getBaichuanLogger();
    const intervalMs = videoclipsRegularChecks * 60 * 1000;

    logger.log(
      `Starting video clips auto-load: checking every ${videoclipsRegularChecks} minutes`,
    );

    // Stagger the initial run so many cameras don't hit their recordings
    // listing at the same instant on plugin startup.
    setTimeout(() => this.loadTodayVideoClipsAndThumbnails(), Math.random() * 60_000);

    // Then run at regular intervals
    this.videoClipsAutoLoadInterval = setInterval(() => {
      this.loadTodayVideoClipsAndThumbnails();
    }, intervalMs);
  }

  /**
   * Load today's video clips and download missing thumbnails
   */
  private async loadTodayVideoClipsAndThumbnails(): Promise<void> {
    // Prevent concurrent executions
    if (this.videoClipsAutoLoadInProgress) {
      const logger = this.getBaichuanLogger();
      logger.debug("Video clips auto-load already in progress, skipping...");
      return;
    }

    const logger = this.getBaichuanLogger();

    this.videoClipsAutoLoadInProgress = true;

    try {
      const daysToPreload =
        this.storageSettings.values.videoclipsDaysToPreload ?? 1;

      // Get date range (start of N days ago to now)
      const now = new Date();
      const startDate = new Date(now);
      startDate.setUTCDate(startDate.getUTCDate() - (daysToPreload - 1));
      startDate.setUTCHours(0, 0, 0, 0);
      startDate.setUTCMinutes(0, 0, 0);

      // Incremental load: on the first run (mark == 0) keep the full backfill
      // over the preload window; on subsequent runs start from the high-water
      // mark (minus a 5min overlap so we never miss a clip that straddled the
      // previous run boundary), but never earlier than the preload window.
      const highWaterMark =
        this.storageSettings.values.videoclipsHighWaterMark ?? 0;
      const OVERLAP_MS = 5 * 60 * 1000;
      const windowStartMs = startDate.getTime();
      const effectiveStartMs =
        highWaterMark > 0
          ? Math.max(windowStartMs, highWaterMark - OVERLAP_MS)
          : windowStartMs;

      logger.log(
        `Auto-loading video clips and thumbnails (${daysToPreload} day window, ` +
          `${highWaterMark > 0 ? "incremental from high-water mark" : "full backfill"})...`,
      );

      // Fetch video clips for the (possibly narrowed) range
      const clips = await this.getVideoClips({
        startTime: effectiveStartMs,
        endTime: now.getTime(),
      });

      logger.log(`Found ${clips.length} video clips to process`);

      const downloadVideoclipsLocally =
        this.storageSettings.values.downloadVideoclipsLocally ?? false;

      // Track processed clips to avoid duplicate calls to the camera
      const processedClips = new Set<string>();
      // Most-recent clip start time fully processed this run; advances the mark.
      let maxProcessedStart = highWaterMark;
      // Only advance the high-water mark if the whole loop completes cleanly.
      let runHadError = false;
      const MIN_THUMB_CACHE_BYTES = 512;

      // Download videos first (if enabled), then thumbnails for each clip
      for (const clip of clips) {
        // Skip if already processed (avoid duplicate calls)
        if (processedClips.has(clip.id)) {
          logger.debug(`Skipping already processed clip: ${clip.id}`);
          continue;
        }
        processedClips.add(clip.id);

        // Cheap pre-check: if the thumbnail is already cached and non-trivial,
        // skip the thumbnail generation entirely. The video file cache is
        // request/HLS-driven (not written by getVideoClip here), so it is NOT
        // used as a skip signal.
        let thumbnailCached = false;
        try {
          const thumbPath = this.getThumbnailCachePath(clip.id);
          const stats = await fs.promises.stat(thumbPath);
          thumbnailCached = stats.size >= MIN_THUMB_CACHE_BYTES;
        } catch {
          // Not cached (or unreadable) — fall through to generate it.
        }

        try {
          // If downloadVideoclipsLocally is enabled, build the video webhook URL.
          // This is cheap (no camera round-trip); only skip the thumbnail below.
          if (downloadVideoclipsLocally && !thumbnailCached) {
            try {
              // Call getVideoClip to trigger download and caching
              await this.getVideoClip(clip.id);
              logger.debug(`Downloaded video clip: ${clip.id}`);
            } catch (e) {
              logger.warn(
                `Failed to download video clip ${clip.id}:`,
                e instanceof Error ? e.message : String(e),
              );
            }
          }

          if (thumbnailCached) {
            logger.debug(`Skipping already cached thumbnail: ${clip.id}`);
          } else {
            // Then get the thumbnail - this will use the local video file if
            // available or call the camera if the video wasn't downloaded
            try {
              await this.getVideoClipThumbnail(clip.id);
              logger.debug(`Downloaded thumbnail for clip: ${clip.id}`);
            } catch (e) {
              runHadError = true;
              logger.warn(
                `Failed to load thumbnail for clip ${clip.id}:`,
                e instanceof Error ? e.message : String(e),
              );
            }
          }

          // Track the most-recent successfully-handled clip for the mark.
          if (typeof clip.startTime === "number") {
            maxProcessedStart = Math.max(maxProcessedStart, clip.startTime);
          }
        } catch (e) {
          runHadError = true;
          logger.warn(
            `Error processing clip ${clip.id}:`,
            e instanceof Error ? e.message : String(e),
          );
        }
      }

      // Advance the high-water mark only after a fully clean run, so a transient
      // failure forces a re-scan of the same window on the next pass.
      if (!runHadError && maxProcessedStart > highWaterMark) {
        this.storageSettings.values.videoclipsHighWaterMark = maxProcessedStart;
      }

      logger.log(`Completed auto-loading video clips and thumbnails`);
    } catch (e) {
      logger.error(
        "Error during auto-loading video clips:",
        e?.message || String(e),
      );
    } finally {
      this.videoClipsAutoLoadInProgress = false;
    }
  }

  async reboot(): Promise<void> {
    const api = await this.ensureClient();
    await api.reboot();
  }

  // BaseBaichuanClass abstract methods implementation
  protected getConnectionConfig(): BaichuanConnectionConfig {
    const { ipAddress, username, password, uid, discoveryMethod } =
      this.storageSettings.values;
    const debugOptions = this.getBaichuanDebugOptions();

    // UDP cameras (battery or UDP-only like Elite Floodlight WiFi) require UID
    // const requiresUid = this.isBattery || this.isUdpCamera;
    // const normalizedUid = requiresUid ? normalizeUid(uid) : undefined;
    const normalizedUid = normalizeUid(uid);

    // if (requiresUid && !normalizedUid) {
    //   throw new Error("UID is required for UDP cameras (BCUDP)");
    // }

    // Prevent accidental connections to localhost (Node will default host=127.0.0.1 when host is undefined).
    // This shows up as connect ECONNREFUSED 127.0.0.1:9000 and will never recover with socket resets.
    // if (!requiresUid && !ipAddress) {
    //   throw new Error("IP Address is required for TCP devices");
    // }

    // The lib's `emailPushCameraId` auto-bridge would die every time
    // the plugin calls `cleanupBaichuanApi` (every idle_disconnect on
    // battery cams — every ~30s of idle). In that window SMTP motion
    // events emitted on the global bus have no listener and are lost.
    // Instead, the camera subscribes to the bus directly in `init()`
    // via `subscribeToEmailPushBus()` — that subscription is tied to
    // the camera (Scrypted device) lifecycle, not to the api object,
    // so it survives every api recreate / idle disconnect / wake.

    return {
      host: ipAddress,
      username,
      password,
      uid: normalizedUid,
      transport: this.protocol,
      debugOptions,
      udpDiscoveryMethod: discoveryMethod,
      // NOTE: idleDisconnect is NOT set here - the library handles it internally
      // based on the battery status detected during connection
    };
  }

  protected getConnectionCallbacks(): BaichuanConnectionCallbacks {
    return {
      onClose: async () => {
        // Reset client state on close
        // The base class already handles cleanup
        // For battery cameras, don't auto-resubscribe after idle disconnects
        // (idle disconnects are normal for battery cameras to save power)
        if (!this.isBattery) {
          const logger = this.getBaichuanLogger();
          const maxRetries = 3;
          const baseDelayMs = 2000;

          const attemptResubscribe = async (attempt: number) => {
            try {
              await this.subscribeToEvents();
            } catch (e) {
              if (attempt < maxRetries) {
                const delay = baseDelayMs * Math.pow(2, attempt);
                logger.warn(
                  `Failed to resubscribe to events after reconnection (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms`,
                  e?.message || String(e),
                );
                setTimeout(() => attemptResubscribe(attempt + 1), delay);
              } else {
                logger.warn(
                  `Failed to resubscribe to events after ${maxRetries} attempts, relying on eventCheck interval for recovery`,
                  e?.message || String(e),
                );
              }
            }
          };

          setTimeout(() => attemptResubscribe(0), baseDelayMs);
        }
      },
      onSimpleEvent: this.onSimpleEventBound,
      getEventSubscriptionEnabled: () =>
        this.isEventDispatchEnabled?.() ?? false,
      // Email-push events are wired in `init()` directly against the
      // lib's global bus — NOT through the api here, because for
      // battery cams the Baichuan api lifetime is much shorter than
      // the camera lifetime (api closes when the cam sleeps), so an
      // api-level subscription would be dead by the time the next
      // motion email arrives. See `subscribeToEmailPushBus()`.
    };
  }

  protected isDebugEnabled(): boolean {
    return this.storageSettings.values.debugLogs;
  }

  protected isBatteryDevice(): boolean {
    return this.isBattery;
  }

  protected getDeviceName(): string {
    return this.name || "Camera";
  }

  async withBaichuanRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isBattery) {
      return await fn();
    } else {
      try {
        return await fn();
      } catch (e) {
        if (!this.isRecoverableBaichuanError(e)) {
          throw e;
        }

        // Reset client and clear cache on recoverable error
        await this.resetBaichuanClient(e);

        // Important: callers must re-acquire the client inside fn.
        try {
          return await fn();
        } catch (retryError) {
          throw retryError;
        }
      }
    }
  }

  async runDiagnostics(): Promise<void> {
    const logger = this.getBaichuanLogger();
    const outputPath =
      this.storageSettings.values.diagnosticsOutputPath ||
      process.env.SCRYPTED_PLUGIN_VOLUME ||
      "";

    if (!outputPath) {
      throw new Error("Diagnostics output path is required");
    }

    const channel = this.storageSettings.values.rtspChannel || 0;
    const durationSeconds = 15;
    const selection: StreamSamplingSelection = {
      kinds: ["native"],
      profiles: ["main", "ext", "sub"],
    };

    logger.log(
      `Starting diagnostics with parameters: outDir=${outputPath}, channel=${channel}, durationSeconds=${durationSeconds}, selection=${JSON.stringify(selection)}`,
    );

    try {
      const api = await this.ensureClient();
      const { ipAddress, username, password } = this.storageSettings.values;

      const result = await api.runAllDiagnosticsConsecutively({
        host: ipAddress,
        username,
        password,
        outDir: outputPath,
        channel,
        durationSeconds,
        selection,
        api,
      });

      logger.log(
        `Diagnostics completed successfully. Output directory: ${result.runDir}`,
      );
      logger.log(`Diagnostics file: ${result.diagnosticsPath}`);
      logger.log(`Streams directory: ${result.streamsDir}`);
    } catch (e) {
      logger.error("Failed to run diagnostics", e?.message || String(e));
      throw e;
    }
  }

  async dumpModelFixtures(): Promise<void> {
    const logger = this.getBaichuanLogger();
    const channel = this.storageSettings.values.rtspChannel || 0;
    const basePath =
      this.storageSettings.values.diagnosticsOutputPath ||
      path.join(process.env.SCRYPTED_PLUGIN_VOLUME, "diagnostics", this.name);
    const outDir = path.join(basePath, "model-fixtures", `ch${channel}`);

    logger.log(`Dumping model fixtures: channel=${channel}, outDir=${outDir}`);

    try {
      const api = await this.ensureClient();
      const { captureModelFixtures: capture } =
        await import("@apocaliss92/nodelink-js");
      const result = await capture({
        api,
        channel,
        outDir,
        log: (...args: unknown[]) => logger.log(String(args.join(" "))),
      });

      logger.log(
        `Model fixtures captured: ${result.summary.ok}/${result.summary.total} ok, ${result.summary.failed} failed`,
      );
      if (result.summary.errors.length) {
        logger.warn(
          `Failed calls:\n${result.summary.errors.map((e) => `  - ${e}`).join("\n")}`,
        );
      }
      logger.log(`Output: ${outDir}`);
    } catch (e) {
      logger.error("Failed to dump model fixtures", e?.message || String(e));
      throw e;
    }
  }

  protected async onBeforeCleanup(): Promise<void> {
    // Unsubscribe from events if needed
    if (this.baichuanApi) {
      try {
        // Must await: offSimpleEvent is async and accesses the socket pool.
        // Without await the rejection becomes unhandled when api.close()
        // destroys the pool before the promise settles.
        await this.baichuanApi.offSimpleEvent(this.onSimpleEventBound);
      } catch {
        // ignore - socket may already be destroyed
      }
    }

    // Close all active streams when connection is being cleaned up
    // This ensures no streams remain active when the main connection closes
    if (this.streamManager) {
      try {
        const hasActiveStreams = this.streamManager.hasActiveStreams();
        if (hasActiveStreams) {
          const logger = this.getBaichuanLogger();
          logger.log("Closing all active streams due to connection cleanup");
          await this.streamManager.closeAllStreams("connection cleanup");
        }
      } catch (e) {
        const logger = this.getBaichuanLogger();
        logger.error(
          "Error closing streams during cleanup:",
          e?.message || String(e),
        );
      }
    }
  }

  /**
   * Create a dedicated Baichuan API session for streaming (used by StreamManager).
   *
   * - For TCP devices (regular + multifocal), this creates a new TCP session with its own client.
   * - For UDP/battery devices, this reuses the existing client via ensureClient().
   */
  async createStreamClient(streamKey: string): Promise<ReolinkBaichuanApi> {
    // Determine who should create the socket based on device hierarchy:
    // 1. Camera of multifocal with nvrDevice -> nvrDevice creates the socket
    // 2. Camera of multifocal (without nvrDevice) -> multiFocalDevice creates the socket
    // 3. Camera of nvr -> nvrDevice creates the socket
    // 4. Standalone camera -> camera creates its own socket (via base class)

    // Case 1: Camera of multifocal with nvrDevice -> delegate to nvrDevice
    if (this.multiFocalDevice?.nvrDevice) {
      return await this.multiFocalDevice.nvrDevice.createStreamClient(
        streamKey,
      );
    }

    // Case 2: Camera of multifocal (without nvrDevice) -> delegate to multiFocalDevice
    if (this.multiFocalDevice) {
      return await this.multiFocalDevice.createStreamClient(streamKey);
    }

    // Case 3: Camera of nvr -> delegate to nvrDevice
    if (this.nvrDevice) {
      return await this.nvrDevice.createStreamClient(streamKey);
    }

    // Case 4: Standalone camera -> create its own socket using base class method
    // For battery (BCUDP) cameras, streaming must be keyed by streamKey.
    // Do NOT reuse ensureClient(): composite needs two concurrent streams, and single-lens streams
    // should reuse the same API that composite already created for that same streamKey.
    if (this.isBattery) {
      return await super.createStreamClient(streamKey);
    }

    // For TCP standalone cameras, use base class createStreamClient which manages stream clients per streamKey
    return await super.createStreamClient(streamKey);
  }

  public async getAbilities(): Promise<DeviceCapabilities> {
    const logger = this.getBaichuanLogger();

    try {
      if (this.multiFocalDevice) {
        const variantType = this.storageSettings.values.variantType;
        const ifaces = await this.multiFocalDevice.getInterfaces(variantType);
        if (ifaces?.capabilities) return ifaces.capabilities;
      } else {
        if (this.cachedCapabilities) return this.cachedCapabilities;

        const client = await this.ensureClient();
        const { capabilities, debug } = await client.getDeviceCapabilities(
          this.storageSettings.values.rtspChannel ?? 0,
        );
        this.cachedCapabilities = capabilities;
        logger.debug("Device capabilities retrieved", debug);
        return capabilities;
      }
    } catch (e) {
      logger.error("Failed to get abilities", e);
      return {
        channel: this.storageSettings.values.rtspChannel ?? 0,
        ptzMode: "none",
        hasPan: false,
        hasTilt: false,
        hasZoom: false,
        hasPresets: false,
        hasPtz: false,
        hasBattery: !!this.isBattery,
        hasIntercom: false,
        hasSiren: false,
        hasFloodlight: false,
        hasPir: false,
        hasAutotracking: false,
        isDoorbell: false,
        hasWirelessChime: false,
      };
    }
  }

  getBaichuanDebugOptions(): any | undefined {
    const socketDebugLogs =
      this.storageSettings.values.socketApiDebugLogs || [];
    const apiOptions = convertDebugLogsToApiOptions(socketDebugLogs);
    if (this.storageSettings.values.debugLogs) {
      return { ...apiOptions, general: true };
    }
    return apiOptions;
  }

  /**
   * Get StreamManager if available
   */
  protected getStreamManager(): StreamManager | undefined {
    return this.streamManager;
  }

  /**
   * Initialize or recreate the StreamManager, taking into account multifocal composite options.
   */
  protected async initStreamManager(
    logger?: Console,
    forceRecreate: boolean = false,
  ): Promise<void> {
    const { username, password } = this.storageSettings.values;
    // Ensure logger is always valid - use provided logger or get from device, fallback to console
    const validLogger = logger || this.getBaichuanLogger() || console;

    const baseOptions: StreamManagerOptions = {
      createStreamClient: this.createStreamClient.bind(this),
      logger: validLogger,
      credentials: {
        username,
        password,
      },
      sharedConnection: this.isBattery || !!this.nvrDevice,
      // Pass nativeId for dedicated socket sessions (avoids stream interference)
      deviceId: this.id,
    };

    if (this.isMultiFocal) {
      const {
        pipPosition,
        pipSize,
        pipMargin,
        rtspChannel,
        compositeAssumeH264,
        compositeDisableTranscode,
        compositeVideoEncoder,
        compositeEncoderPreset,
        compositeCrf,
        compositeGopSeconds,
        compositeExtraGlobalArgs,
        compositeExtraOutputArgs,
      } = this.storageSettings.values;
      // Get the path to the ffmpeg binary Scrypted ships with. The
      // composite stream spawns ffmpeg directly; on Windows / Electron
      // the host has a stripped PATH so a bare `ffmpeg` ENOENTs — we
      // MUST pass the absolute path the SDK knows about.
      let ffmpegPath: string | undefined;
      try {
        ffmpegPath = await sdk.mediaManager.getFFmpegPath();
      } catch {
        // Older Scrypted runtimes / weird environments may not expose
        // this. Fall through to the library's default ("ffmpeg" via PATH);
        // worst case the composite fails to spawn and the user sees a
        // friendly error.
        ffmpegPath = undefined;
      }
      // Whitespace-split the free-form extra args. Empty string -> [].
      const splitArgs = (s: string | undefined): string[] | undefined => {
        if (typeof s !== "string") return undefined;
        const arr = s
          .trim()
          .split(/\s+/)
          .filter((a) => a.length > 0);
        return arr.length > 0 ? arr : undefined;
      };
      const extraGlobalArgs = splitArgs(compositeExtraGlobalArgs);
      const extraOutputArgs = splitArgs(compositeExtraOutputArgs);

      // Resolve the human-readable encoder label the user picked back
      // into the actual ffmpeg `-c:v` identifier. The helper returns
      // arrays shaped like ['-c:v', 'h264_videotoolbox', ...extras] —
      // we pull element [1] for the encoder name and propagate any
      // additional pix-fmt / pix-encoder args via extraOutputArgs so
      // they end up just before the output pipe.
      let resolvedVideoEncoder: string | undefined;
      let encoderImpliedOutputArgs: string[] = [];
      if (compositeVideoEncoder) {
        try {
          const encoderArgs = getCompositeH264EncoderArgs()[compositeVideoEncoder];
          // Some entries (V4L2/Raspberry Pi) carry pre-`-c:v` pixel-format
          // args. Find where `-c:v` is in the array — everything before
          // becomes encoderImpliedOutputArgs (pixfmt), the element after
          // `-c:v` is the encoder identifier, and anything after that is
          // also part of encoderImpliedOutputArgs.
          const cvIdx = encoderArgs?.indexOf("-c:v") ?? -1;
          if (encoderArgs && cvIdx >= 0 && encoderArgs[cvIdx + 1]) {
            resolvedVideoEncoder = encoderArgs[cvIdx + 1]!;
            // Everything except the `-c:v <encoder>` pair becomes extra
            // output args, preserving any pixel-format hints the upstream
            // helper baked in (e.g. yuv420p for V4L2).
            encoderImpliedOutputArgs = [
              ...encoderArgs.slice(0, cvIdx),
              ...encoderArgs.slice(cvIdx + 2),
            ];
          }
        } catch {
          // ignore; fall back to library default below
        }
      }
      const finalExtraOutputArgs = encoderImpliedOutputArgs.length || extraOutputArgs
        ? [...encoderImpliedOutputArgs, ...(extraOutputArgs ?? [])]
        : undefined;

      // On NVR/Hub, TrackMix lenses are selected via stream variant, not via a separate channel.
      // Use rtspChannel for BOTH wide and tele so the library can request tele via streamType/variant.
      const wider = this.isOnNvr ? rtspChannel : undefined;
      const tele = this.isOnNvr ? rtspChannel : undefined;

      // On standalone TrackMix/Duo, lens channels are often separate, but they are not always 0/1.
      // Prefer using the discovered multifocalInfo mapping when available.
      let derivedWider: number | undefined = wider;
      let derivedTele: number | undefined = tele;
      if (!this.isOnNvr) {
        try {
          const info: any = this.storageSettings.values.multifocalInfo;
          const channels: any[] = Array.isArray(info?.channels)
            ? info.channels
            : [];

          const wideCh =
            channels.find((c) => c?.lensType === "wide")?.channel ??
            channels.find((c) => c?.variantType === "default")?.channel;
          const teleCh =
            channels.find((c) => c?.lensType === "telephoto")?.channel ??
            channels.find((c) => c?.variantType === "telephoto")?.channel;

          if (Number.isFinite(wideCh)) derivedWider = wideCh;
          if (Number.isFinite(teleCh)) derivedTele = teleCh;

          // Avoid setting nonsense; leave undefined to fall back to library defaults.
          if (derivedWider === derivedTele) {
            // Keep undefined behavior (defaults inside the library) unless we are on NVR.
            derivedWider = undefined;
            derivedTele = undefined;
          }
        } catch {
          // ignore and fall back to defaults
        }
      }

      baseOptions.compositeOptions = {
        widerChannel: derivedWider,
        teleChannel: derivedTele,
        pipPosition,
        pipSize,
        pipMargin,
        onNvr: this.isOnNvr,
        // Prefer H.264 for composite (sub+sub by default) to reduce GOP latency.
        forceH264: true,
        assumeH264Inputs: compositeAssumeH264 ?? true,
        disableTranscode: compositeDisableTranscode ?? false,
        // ffmpeg knobs — only include when set so the library defaults stay live.
        ...(ffmpegPath ? { ffmpegPath } : {}),
        ...(resolvedVideoEncoder
          ? { videoEncoder: resolvedVideoEncoder }
          : {}),
        ...(compositeEncoderPreset
          ? { encoderPreset: compositeEncoderPreset }
          : {}),
        ...(typeof compositeCrf === "number" ? { crf: compositeCrf } : {}),
        ...(typeof compositeGopSeconds === "number"
          ? { gopSeconds: compositeGopSeconds }
          : {}),
        ...(extraGlobalArgs ? { extraGlobalArgs } : {}),
        ...(finalExtraOutputArgs ? { extraOutputArgs: finalExtraOutputArgs } : {}),
      };
    }

    if (!this.streamManager || forceRecreate) {
      this.streamManager = new StreamManager(baseOptions);
    }
  }

  /**
   * Debounced restart of StreamManager when PIP/composite settings change.
   * Also notifies listeners so that active streams (prebuffer, etc.) restart cleanly.
   */
  protected scheduleStreamManagerRestart(reason: string): void {
    const logger = this.getBaichuanLogger();
    logger.log(`Scheduling StreamManager restart (${reason})`);

    if (this.streamManagerRestartTimeout) {
      clearTimeout(this.streamManagerRestartTimeout);
      this.streamManagerRestartTimeout = undefined;
    }

    this.streamManagerRestartTimeout = setTimeout(async () => {
      this.streamManagerRestartTimeout = undefined;
      const logger = this.getBaichuanLogger();
      try {
        logger.log(
          "Restarting StreamManager due to PIP/composite settings change",
        );
        await this.initStreamManager(logger, true);

        // Invalidate snapshot cache for battery/multifocal-battery so that
        // the next snapshot reflects the new PIP/composite configuration.
        if (this.isBattery) {
          this.forceNewSnapshot = true;
          this.lastPicture = undefined;
        }

        this.onDeviceEvent(ScryptedInterface.VideoCamera, undefined);
      } catch (e) {
        logger.error(
          "Failed to restart StreamManager after settings change",
          e?.message || String(e),
        );
      }
    }, 500);
  }

  isRecoverableBaichuanError(e: any): boolean {
    const message = e?.message || e?.toString?.() || "";
    return (
      typeof message === "string" &&
      (message.includes("Baichuan socket closed") ||
        message.includes("Baichuan UDP stream closed") ||
        message.includes("Baichuan TCP socket is not connected") ||
        message.includes("socket hang up") ||
        message.includes("ECONNRESET") ||
        message.includes("EPIPE"))
    );
  }

  async updatePtzCaps() {
    const { hasPan, hasTilt, hasZoom } = await this.getAbilities();
    this.ptzCapabilities = {
      ...this.ptzCapabilities,
      pan: hasPan,
      tilt: hasTilt,
      zoom: hasZoom,
    };
  }

  // Event subscription methods
  unsubscribedToEvents(): void {
    // NOTE: Do NOT call unsubscribeFromEvents() here fire-and-forget.
    // super.subscribeToEvents() already awaits unsubscribeFromEvents() properly.
    // A fire-and-forget unsubscribe races with concurrent subscribe calls:
    // the async removal can delete a handler that was just registered by another
    // caller, silently killing event delivery with no watchdog recovery.

    if (this.motionDetected) {
      this.motionDetected = false;
    }
  }

  onSimpleEvent(ev: ReolinkSimpleEvent) {
    const logger = this.getBaichuanLogger();

    try {
      const logger = this.getBaichuanLogger();
      const isDispatchEnabled = this.isEventDispatchEnabled();

      logger.debug(
        `Baichuan event on camera (dispatch enabled: ${isDispatchEnabled}):`,
        ev,
      );

      if (!isDispatchEnabled) {
        logger.debug("Event dispatch is disabled, ignoring event");
        return;
      }

      const objects: string[] = [];
      let motion = false;

      switch (ev?.type) {
        case "awake":
        case "sleeping":
          this.updateSleepingState({
            reason: ev?.type === "sleeping" ? "sleeping" : "awake",
            state: ev.type === "sleeping" ? "sleeping" : "awake",
          }).catch((e) => {
            logger.warn(
              "Error updating sleeping state",
              e?.message || String(e),
            );
          });
          return;

        case "battery":
          if (ev.battery) {
            this.updateBatteryInfo(ev.battery as any).catch((e) => {
              logger.debug(
                "Error updating battery from push",
                e?.message || String(e),
              );
            });
          }
          return;

        case "offline":
        case "online":
          this.updateOnlineState(ev.type === "online").catch((e) => {
            logger.warn("Error updating online state", e?.message || String(e));
          });
          return;

        case "motion":
          motion = true;
          break;

        case "doorbell":
          this.handleDoorbellEvent();
          motion = true;
          break;

        case "people":
        case "vehicle":
        case "animal":
        case "face":
        case "package":
        case "other":
          if (this.shouldDispatchObjects()) objects.push(ev.type);
          motion = true;
          break;

        default:
          logger.error(`Unknown event type: ${ev?.type}`);
          return;
      }

      this.processEvents({ motion, objects }).catch((e) => {
        logger.warn("Error processing events", e?.message || String(e));
      });

      // Battery cams cache `lastPicture` aggressively because waking
      // the device for a snapshot is expensive. When motion fires the
      // cam is, by definition, awake right now — proactively refresh
      // the cache so the Snapshot mixin → MQTT image entity / HA
      // discovery serves the trigger frame on the next `takePicture`
      // call instead of the previous cached one. Wired cams don't
      // need this (Snapshot mixin always gets fresh data anyway).
      if (motion && this.isBattery && !this.multiFocalDevice) {
        void this.refreshSnapshotOnMotion(ev.timestamp ?? Date.now());
      }
    } catch (e) {
      logger.warn("Error in onSimpleEvent handler", e?.message || String(e));
    }
  }

  /**
   * Subscribe to Baichuan events only if this is a standalone device (not a child of NVR or MultiFocal).
   * If this device has a parent (nvrDevice or multiFocalDevice), events will be forwarded from the parent.
   * This ensures that only the root device in the hierarchy subscribes to events, avoiding duplicate subscriptions.
   */
  async subscribeToEvents(silent: boolean = false): Promise<void> {
    // If this device has a parent (NVR or MultiFocal), don't subscribe - events will be forwarded from parent
    if (this.nvrDevice || this.multiFocalDevice) {
      const logger = this.getBaichuanLogger();
      logger.debug(
        `Device has parent (nvrDevice=${!!this.nvrDevice}, multiFocalDevice=${!!this.multiFocalDevice}), skipping event subscription (events will be forwarded from parent)`,
      );
      return;
    }

    const logger = this.getBaichuanLogger();
    const selection = Array.from(
      this.getDispatchEventsSelection?.() ?? new Set(),
    ).sort();
    const enabled = selection.length > 0;

    logger.debug(
      `subscribeToEvents called: enabled=${enabled}, selection=[${selection.join(", ")}], protocol=${this.protocol}`,
    );

    this.unsubscribedToEvents();

    const shouldDispatchMotion = selection.includes("motion");
    if (!shouldDispatchMotion) {
      if (this.motionTimeout) clearTimeout(this.motionTimeout);
      this.motionDetected = false;
    }

    if (!enabled) {
      if (!silent) {
        logger.log("Event subscription disabled, unsubscribing");
      }
      if (this.doorbellBinaryTimeout) {
        clearTimeout(this.doorbellBinaryTimeout);
        this.doorbellBinaryTimeout = undefined;
      }
      this.binaryState = false;
      return;
    }

    // IMPORTANT: use base subscription logic so the callback is properly bound.
    // Passing `this.onSimpleEvent` directly would lose `this` and can result in silent failures.
    try {
      await super.subscribeToEvents(silent);
      if (!silent) {
        logger.log(
          `Subscribed to events (${selection.join(", ")}) on ${this.protocol} connection`,
        );
      }
    } catch (e) {
      logger.warn(
        "Failed to subscribe to Baichuan events",
        e?.message || String(e),
      );
      return;
    }
  }

  // VideoTextOverlays interface implementation
  async getVideoTextOverlays(): Promise<Record<string, VideoTextOverlay>> {
    const client = await this.ensureClient();
    const channel = this.storageSettings.values.rtspChannel;

    let osd = this.storageSettings.values.cachedOsd;

    if (!osd?.length) {
      osd = await client.getOsd(channel);
      this.storageSettings.values.cachedOsd = osd;
    }

    return {
      osdChannel: {
        text: osd?.osdChannel?.enable ? osd.osdChannel.name : undefined,
      },
      osdTime: {
        text: !!osd?.osdTime?.enable,
        readonly: true,
      },
    };
  }

  async setVideoTextOverlay(
    id: "osdChannel" | "osdTime",
    value: VideoTextOverlay,
  ): Promise<void> {
    const client = await this.ensureClient();
    const channel = this.storageSettings.values.rtspChannel;

    const osd = await client.getOsd(channel);

    if (id === "osdChannel") {
      const nextName = typeof value?.text === "string" ? value.text.trim() : "";
      const enable = !!nextName || value?.text === true;
      osd.osdChannel.enable = enable ? 1 : 0;
      // Name must always be valid when enabled.
      if (enable) {
        osd.osdChannel.name =
          nextName || osd.osdChannel.name || this.name || "Camera";
      }
    } else if (id === "osdTime") {
      osd.osdTime.enable = value?.text ? 1 : 0;
    } else {
      throw new Error("unknown overlay: " + id);
    }

    await client.setOsd(channel, osd);
  }

  // PanTiltZoom interface implementation
  async ptzCommand(command: PanTiltZoomCommand): Promise<void> {
    const logger = this.getBaichuanLogger();

    const client = await this.ensureClient();
    if (!client) {
      return;
    }

    const channel = this.storageSettings.values.rtspChannel;

    // Preset navigation.
    const preset = command.preset;
    if (preset !== undefined && preset !== null) {
      const presetId = Number(preset);
      if (!Number.isFinite(presetId)) {
        logger.warn(`Invalid PTZ preset id: ${preset}`);
        return;
      }
      if (this.ptzPresets) {
        await this.ptzPresets.moveToPreset(presetId);
      } else {
        logger.warn("PTZ presets not available");
      }
      return;
    }

    // Map PanTiltZoomCommand to PtzCommand
    let ptzAction: "start" | "stop" = "start";
    let ptzCommand:
      | "Left"
      | "Right"
      | "Up"
      | "Down"
      | "ZoomIn"
      | "ZoomOut"
      | "FocusNear"
      | "FocusFar" = "Left";

    if (command.pan !== undefined) {
      if (command.pan === 0) {
        // Stop pan movement - send stop with last direction
        ptzAction = "stop";
        ptzCommand = "Left"; // Use any direction for stop
      } else {
        ptzCommand = command.pan > 0 ? "Right" : "Left";
        ptzAction = "start";
      }
    } else if (command.tilt !== undefined) {
      if (command.tilt === 0) {
        // Stop tilt movement
        ptzAction = "stop";
        ptzCommand = "Up"; // Use any direction for stop
      } else {
        ptzCommand = command.tilt > 0 ? "Up" : "Down";
        ptzAction = "start";
      }
    } else if (command.zoom !== undefined) {
      // Zoom is handled separately.
      // Scrypted typically provides a normalized zoom value; treat it as direction and apply a step.
      const z = Number(command.zoom);
      if (!Number.isFinite(z) || z === 0) return;

      const step = Number(this.storageSettings.values.ptzZoomStep);
      if (!Number.isFinite(step) || step <= 0) {
        logger.warn("Invalid PTZ zoom step, using default 0.1");
        return;
      }

      // Get current zoom factor and apply step
      const info = await client.getZoomFocus(channel);
      if (!info?.zoom) {
        logger.warn(
          "Zoom command requested but camera did not report zoom support.",
        );
        return;
      }

      // In Baichuan API, 1000 == 1.0x.
      const curFactor = (info.zoom.curPos ?? 1000) / 1000;
      const minFactor = (info.zoom.minPos ?? 1000) / 1000;
      const maxFactor = (info.zoom.maxPos ?? 1000) / 1000;
      const stepFactor = step;

      const direction = z > 0 ? 1 : -1;
      const next = Math.min(
        maxFactor,
        Math.max(minFactor, curFactor + direction * stepFactor),
      );
      await client.zoomToFactor(channel, next);
      return;
    }

    const ptzCmd: PtzCommand = {
      action: ptzAction,
      command: ptzCommand,
      speed: typeof command.speed === "number" ? command.speed : 32,
      autoStopMs: Number(this.storageSettings.values.ptzMoveDurationMs) || 500,
    };

    await client.ptz(channel, ptzCmd);
  }

  // ObjectDetector interface implementation
  async getObjectTypes(): Promise<ObjectDetectionTypes> {
    return {
      classes: this.classes,
    };
  }

  async getDetectionInput(
    detectionId: string,
    eventId?: any,
  ): Promise<MediaObject> {
    return null;
  }

  getDispatchEventsSelection(): Set<"motion" | "objects"> {
    return new Set(this.storageSettings.values.dispatchEvents);
  }

  isEventDispatchEnabled(): boolean {
    return this.getDispatchEventsSelection().size > 0;
  }

  shouldDispatchMotion(): boolean {
    return this.getDispatchEventsSelection().has("motion");
  }

  shouldDispatchObjects(): boolean {
    return this.getDispatchEventsSelection().has("objects");
  }

  async processEvents(events: {
    motion?: boolean;
    objects?: string[];
  }): Promise<void> {
    const isEventDispatchEnabled = this.isEventDispatchEnabled?.() ?? true;
    if (!isEventDispatchEnabled) return;

    const logger = this.getBaichuanLogger();

    const dispatchEvents =
      this.getDispatchEventsSelection?.() ?? new Set(["motion", "objects"]);
    const shouldDispatchMotion = dispatchEvents.has("motion");
    const shouldDispatchObjects = dispatchEvents.has("objects");

    logger.debug(
      `Processing events ${JSON.stringify({
        isMotion: events.motion,
        objects: events.objects,
        currentMotion: this.motionDetected,
        shouldDispatchMotion,
        shouldDispatchObjects,
      })}`,
    );

    if (shouldDispatchMotion && events.motion !== undefined) {
      const motionDetected = events.motion;
      if (motionDetected !== this.motionDetected) {
        logger.log(`Motion detected: ${motionDetected}`);
        this.motionDetected = motionDetected;
      }

      if (motionDetected) {
        if (this.motionTimeout) clearTimeout(this.motionTimeout);
        const timeout =
          (this.storageSettings.values.motionTimeout || 30) * 1000;
        this.motionTimeout = setTimeout(() => {
          this.motionDetected = false;
        }, timeout);
      } else {
        if (this.motionTimeout) clearTimeout(this.motionTimeout);
      }
    }

    if (shouldDispatchObjects && events.objects?.length) {
      const od: ObjectsDetected = {
        timestamp: Date.now(),
        detections: [],
      };
      for (const c of events.objects) {
        od.detections.push({
          className: c,
          score: 1,
        });
      }
      if (this.nativeId) {
        sdk.deviceManager.onDeviceEvent(
          this.nativeId,
          ScryptedInterface.ObjectDetector,
          od,
        );
      }
    }
  }

  handleDoorbellEvent(): void {
    if (!this.doorbellBinaryTimeout) {
      this.binaryState = true;
      this.doorbellBinaryTimeout = setTimeout(() => {
        this.binaryState = false;
        this.doorbellBinaryTimeout = undefined;
      }, 5000);
    }
  }

  clearDoorbellBinary(): void {
    if (this.doorbellBinaryTimeout) {
      clearTimeout(this.doorbellBinaryTimeout);
      this.doorbellBinaryTimeout = undefined;
    }
    this.binaryState = false;
  }

  async reportDevices(): Promise<void> {
    const abilities = await this.getAbilities();
    const logger = this.getBaichuanLogger();
    logger.log(`Reporting devices: ${JSON.stringify(abilities)}`);

    const {
      hasSiren,
      hasFloodlight,
      hasPir,
      hasAutotracking,
      hasWirelessChime,
    } = abilities;

    // Define native IDs for all sub-devices
    const motionSirenNativeId = `${this.nativeId}${motionSirenSuffix}`;
    const sirenNativeId = `${this.nativeId}${sirenSuffix}`;
    const motionFloodlightNativeId = `${this.nativeId}${motionFloodlightSuffix}`;
    const floodlightNativeId = `${this.nativeId}${floodlightSuffix}`;
    const pirNativeId = `${this.nativeId}${pirSuffix}`;
    const autotrackingNativeId = `${this.nativeId}${autotrackingSuffix}`;
    const chimeNativeId = `${this.nativeId}${chimeSuffix}`;

    // Helper to safely remove a device only if it exists
    const safeRemoveDevice = (nativeId: string) => {
      const existingIds = sdk.deviceManager.getNativeIds();
      if (existingIds.includes(nativeId)) {
        sdk.deviceManager.onDeviceRemoved(nativeId);
      }
    };

    // Create motion-siren device (motion detection alarm)
    if (hasSiren) {
      const device: Device = {
        providerNativeId: this.nativeId,
        name: `${this.name} Motion-Siren`,
        nativeId: motionSirenNativeId,
        info: {
          ...(this.info || {}),
        },
        interfaces: [ScryptedInterface.OnOff, ScryptedInterface.Settings],
        type: ScryptedDeviceType.Siren,
      };
      sdk.deviceManager.onDeviceDiscovered(device);
    } else {
      // Remove motion-siren device if capability is no longer available
      safeRemoveDevice(motionSirenNativeId);
      this.motionSiren = undefined;
    }

    // Create siren device (direct control)
    if (hasSiren) {
      const device: Device = {
        providerNativeId: this.nativeId,
        name: `${this.name} Siren`,
        nativeId: sirenNativeId,
        info: {
          ...(this.info || {}),
        },
        interfaces: [ScryptedInterface.OnOff, ScryptedInterface.Settings],
        type: ScryptedDeviceType.Siren,
      };
      sdk.deviceManager.onDeviceDiscovered(device);
    } else {
      // Remove siren device if capability is no longer available
      safeRemoveDevice(sirenNativeId);
      this.siren = undefined;
    }

    // Create motion-floodlight device (motion detection light)
    if (hasFloodlight) {
      const device: Device = {
        providerNativeId: this.nativeId,
        name: `${this.name} Motion-Floodlight`,
        nativeId: motionFloodlightNativeId,
        info: {
          ...(this.info || {}),
        },
        interfaces: [
          ScryptedInterface.OnOff,
          ScryptedInterface.Brightness,
          ScryptedInterface.Settings,
        ],
        type: ScryptedDeviceType.Light,
      };
      sdk.deviceManager.onDeviceDiscovered(device);
    } else {
      // Remove motion-floodlight device if capability is no longer available
      safeRemoveDevice(motionFloodlightNativeId);
      this.motionFloodlight = undefined;
    }

    // Create floodlight device (direct control)
    if (hasFloodlight) {
      const device: Device = {
        providerNativeId: this.nativeId,
        name: `${this.name} Floodlight`,
        nativeId: floodlightNativeId,
        info: {
          ...(this.info || {}),
        },
        interfaces: [
          ScryptedInterface.OnOff,
          ScryptedInterface.Brightness,
          ScryptedInterface.Settings,
        ],
        type: ScryptedDeviceType.Light,
      };
      sdk.deviceManager.onDeviceDiscovered(device);
    } else {
      // Remove floodlight device if capability is no longer available
      safeRemoveDevice(floodlightNativeId);
      this.floodlight = undefined;
    }

    if (hasPir) {
      const device: Device = {
        providerNativeId: this.nativeId,
        name: `${this.name} PIR`,
        nativeId: pirNativeId,
        info: {
          ...(this.info || {}),
        },
        interfaces: [ScryptedInterface.OnOff, ScryptedInterface.Settings],
        type: ScryptedDeviceType.Switch,
      };
      sdk.deviceManager.onDeviceDiscovered(device);
    } else {
      // Remove PIR device if capability is no longer available
      safeRemoveDevice(pirNativeId);
      this.pirSensor = undefined;
    }

    // Create autotracking device (PTZ auto-tracking/smart track)
    if (hasAutotracking) {
      const device: Device = {
        providerNativeId: this.nativeId,
        name: `${this.name} Autotracking`,
        nativeId: autotrackingNativeId,
        info: {
          ...(this.info || {}),
        },
        interfaces: [ScryptedInterface.OnOff, ScryptedInterface.Settings],
        type: ScryptedDeviceType.Switch,
      };
      sdk.deviceManager.onDeviceDiscovered(device);
    } else {
      // Remove autotracking device if capability is no longer available
      safeRemoveDevice(autotrackingNativeId);
      this.autotracking = undefined;
    }

    // Create chime device (ring paired wireless chime)
    if (hasWirelessChime) {
      const device: Device = {
        providerNativeId: this.nativeId,
        name: `${this.name} Chime`,
        nativeId: chimeNativeId,
        info: {
          ...(this.info || {}),
        },
        interfaces: [ScryptedInterface.OnOff, ScryptedInterface.Settings],
        type: ScryptedDeviceType.Switch,
      };
      sdk.deviceManager.onDeviceDiscovered(device);
    } else {
      safeRemoveDevice(chimeNativeId);
      this.chime = undefined;
    }
  }

  async getSettings(): Promise<Setting[]> {
    const settings = await this.storageSettings.getSettings();

    return settings;
  }

  async putSetting(key: string, value: string): Promise<void> {
    await this.storageSettings.putSetting(key, value);
  }

  /**
   * Push the singleton E-mail Push Server's manager-side SMTP config
   * down to this camera. Mirrors the per-camera select on the server
   * device but lives next to all other per-camera knobs so users can
   * stay on the camera page. NVR-attached / multifocal children skip
   * this — the StorageSettings `hide` flag is set accordingly in init.
   */
  async autoConfigureEmailPushFromServer(): Promise<void> {
    const logger = this.getBaichuanLogger();
    // Materialise the singleton — Scrypted only constructs it after
    // the first `getDevice` call, which may not have happened yet.
    await this.plugin.getDevice(EMAIL_PUSH_SERVER_NATIVE_ID);
    const server = this.plugin.emailPushServer;
    if (!server) {
      throw new Error(
        "Email Push Server not available. Open the 'Reolink E-mail Push Server' device once to initialise it.",
      );
    }
    const params = server.getManagerSetupParamsForCamera({
      id: this.id,
      nativeId: this.nativeId!,
    });
    if (!params) {
      throw new Error(
        "Email Push Server has no usable LAN address yet, or this camera is NVR-attached.",
      );
    }
    const triggers = this.storageSettings.values.emailPushTriggers ?? [
      "MD",
      "people",
      "vehicle",
    ];
    const attachment =
      (this.storageSettings.values.emailPushAttachment as
        | "picture"
        | "video"
        | "none") ?? "picture";

    logger.log(
      `E-mail Push: configuring against ${params.managerHost}:${params.managerPort} (recipient=${params.recipientLocalPart}@${params.domain})`,
    );
    const api = await this.ensureClient();
    await api.setupEmailPushToManager(
      {
        ...params,
        attachmentType: attachment,
        triggerTypes: triggers,
        runTest: false,
      },
      this.storageSettings.values.rtspChannel ?? 0,
    );
    logger.log("E-mail Push: setup applied ✓");
    // Pull the camera's confirmation back into the status row.
    await this.refreshEmailPushStatus().catch((e) => {
      logger.warn(
        `E-mail Push: status refresh after auto-configure failed: ${e?.message || e}`,
      );
    });
  }

  /**
   * Ask the camera to perform a live SMTP send against its current
   * (saved) target. Uses the lib's default 60s timeout — Reolink
   * firmwares can take a while when the manager is slow or DNS resolves
   * after a delay. Result is logged + reflected in the status row.
   */
  async runEmailPushTest(): Promise<void> {
    const logger = this.getBaichuanLogger();
    const api = await this.ensureClient();
    logger.log("E-mail Push: sending test e-mail…");
    const ok = await api.testEmail();
    if (ok) {
      logger.log("E-mail Push: test succeeded ✓");
    } else {
      logger.warn(
        "E-mail Push: test failed (camera reported 482 — check server reachable from camera + credentials).",
      );
    }
    const ts = new Date().toISOString();
    this.storageSettings.values.emailPushCachedStatus = ok
      ? `Test OK at ${ts}`
      : `Test FAILED at ${ts} (482 — server unreachable or auth wrong)`;
  }

  /**
   * Read the camera's current SMTP config (cmdId=42) and render a
   * compact summary into the readonly status row. Wakes battery
   * cameras, so we never trigger this automatically — the user has to
   * click the button.
   */
  async refreshEmailPushStatus(): Promise<void> {
    const logger = this.getBaichuanLogger();
    try {
      const api = await this.ensureClient();
      const cfg = await api.getEmail();
      const ts = new Date().toISOString();
      const target = `${cfg.smtpServer || "(unset)"}:${cfg.smtpPort ?? "?"}`;
      const recipient = cfg.address1 || "(no recipient)";
      this.storageSettings.values.emailPushCachedStatus = `Target: ${target} · Recipient: ${recipient} · refreshed ${ts}`;
      logger.log(
        `E-mail Push: status refreshed (target=${target} recipient=${recipient})`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.storageSettings.values.emailPushCachedStatus = `Failed to read camera config: ${msg}`;
      logger.warn(`E-mail Push: refresh failed: ${msg}`);
    }
  }

  /**
   * Subscribe to the lib's global email-push bus and translate every
   * matching SMTP delivery into a synthetic `ReolinkSimpleEvent` fed
   * to this camera's `onSimpleEvent` — same code path used by native
   * Baichuan push so `motionDetected` flips uniformly.
   *
   * Subscription lifetime is tied to the camera (init → release), NOT
   * to the Baichuan api: the plugin destroys the api on every
   * idle_disconnect (battery cams sleep every ~30s of idle), and a
   * lib-level api auto-bridge would be dead in that window. The
   * camera-level subscription stays alive across every reconnect so
   * SMTP motion always finds a listener and lands on `onSimpleEvent`.
   */
  private async subscribeToEmailPushBus(): Promise<void> {
    if (this.emailPushBusOff) return;
    if (this.isOnNvr || this.multiFocalDevice) return;
    const ownNativeId = this.nativeId ?? "";
    if (!ownNativeId) return;
    const logger = this.getBaichuanLogger();
    try {
      const { onEmailPushEvent, mapEmailPushInferredType } = await import(
        "@apocaliss92/nodelink-js"
      );
      this.emailPushBusOff = onEmailPushEvent((event) => {
        if (event.cameraId !== ownNativeId) return;
        const channel = this.storageSettings.values.rtspChannel ?? 0;
        const mapped = mapEmailPushInferredType(event.inferredType);
        logger.log(
          `E-mail Push event received (type=${event.inferredType}) → dispatching ${mapped}`,
        );
        try {
          this.onSimpleEvent({
            type: mapped,
            channel,
            timestamp: event.receivedAtMs,
          });
          // Fan out a generic motion for AI sub-types so motion-only
          // consumers still flip — mirrors lib's per-api behaviour.
          if (mapped !== "motion" && mapped !== "doorbell") {
            this.onSimpleEvent({
              type: "motion",
              channel,
              timestamp: event.receivedAtMs,
            });
          }
        } catch (e) {
          logger.warn(
            `E-mail Push: onSimpleEvent dispatch threw: ${e?.message || String(e)}`,
          );
        }
      });
      logger.log("E-mail Push: subscribed to global bus");
    } catch (e) {
      logger.warn(
        `E-mail Push: bus subscribe failed: ${e?.message || String(e)}`,
      );
    }
  }

  private unsubscribeFromEmailPushBus(): void {
    if (this.emailPushBusOff) {
      try {
        this.emailPushBusOff();
      } catch {}
      this.emailPushBusOff = undefined;
    }
  }

  /**
   * Refresh the `lastPicture` cache by fetching a live snapshot via
   * the Baichuan API. Used on motion events for battery cameras: the
   * cam is guaranteed awake at that moment (just sent native push or
   * SMTP), so the round-trip is cheap, and downstream consumers
   * (Snapshot mixin → MQTT image entity, HA discovery) reading
   * `takePicture()` on the back of the motion get the trigger frame
   * instead of the previous cached one. Fire-and-forget; per-camera
   * debounce so an event burst doesn't trigger overlapping fetches.
   *
   * Critical for Reolink battery cams: must call `client.wakeUp()`
   * before fetching the snapshot. Reolink firmwares can put the cam
   * back to sleep within a few seconds of the email/motion push, so
   * by the time `getSnapshot` (cmd 109) hits the device it may
   * already be unreachable — the snapshot push response never
   * arrives, the lib times out, and the cmdId=109 hang knocks the
   * UDP session into the reconnect path which itself wakes the cam.
   * `wakeUp` explicitly tells the cam to stay awake long enough to
   * service the snapshot — same pattern as the regular `takePicture`
   * battery path (see line ~2945).
   */
  private lastMotionSnapshotAtMs = 0;
  private motionSnapshotInFlight = false;
  private async refreshSnapshotOnMotion(timestampMs: number): Promise<void> {
    if (this.motionSnapshotInFlight) return;
    if (timestampMs - this.lastMotionSnapshotAtMs < 5_000) return;
    this.motionSnapshotInFlight = true;
    this.lastMotionSnapshotAtMs = timestampMs;
    const logger = this.getBaichuanLogger();
    try {
      const client = await this.ensureClient();
      if (this.isBattery) {
        // Keep the cam awake for the snapshot fetch — without this the
        // cmdId=109 (snapshot push) frequently times out on battery
        // cams and we end up triggering a full socket reconnect which
        // ironically wakes the cam more than the original snapshot.
        await client.wakeUp();
      }
      const mo = await this.takePictureInternal(client);
      this.lastPicture = { mo, atMs: timestampMs };
      this.forceNewSnapshot = false;
      logger.log(
        `Motion snapshot refreshed — next takePicture will serve the trigger frame`,
      );
    } catch (e) {
      // Demote to debug — for battery cams the cam goes back to sleep
      // aggressively and a snapshot miss is normal: the motion event
      // itself was already dispatched on the bus, MQTT/HA will reuse
      // the previous cached frame, no functional impact. Warn would
      // pollute the device log on every motion in noisy environments.
      logger.debug?.(
        `Motion snapshot refresh failed (cam may have slept already): ${e?.message || String(e)}`,
      );
    } finally {
      this.motionSnapshotInFlight = false;
    }
  }

  async takePictureInternal(client: ReolinkBaichuanApi) {
    const { rtspChannel, variantType } = this.storageSettings.values;
    const logger = this.getBaichuanLogger();
    logger.debug(
      `Taking new snapshot from camera: forceNewSnapshot=${this.forceNewSnapshot} channel=${rtspChannel} variant=${variantType}`,
    );

    const compositeOptions = this.isMultiFocal
      ? {
          widerChannel: this.isOnNvr ? rtspChannel : undefined,
          teleChannel: this.isOnNvr ? rtspChannel : undefined,
          pipPosition:
            this.storageSettings.values.pipPosition || "bottom-right",
          pipSize: this.storageSettings.values.pipSize ?? 0.25,
          pipMargin: this.storageSettings.values.pipMargin ?? 10,
          onNvr: this.isOnNvr,
        }
      : undefined;

    // For multifocal devices, request a composite snapshot by passing channel=undefined.
    const channelArg = this.isMultiFocal ? undefined : rtspChannel;

    const snapshotBuffer = await client.getSnapshot(channelArg, {
      onNvr: this.isOnNvr,
      variant: variantType,
      ...(compositeOptions ? { compositeOptions } : {}),
    });
    const mo = await this.createMediaObject(snapshotBuffer, "image/jpeg");

    return mo;
  }

  async takePicture(options?: RequestPictureOptions) {
    if (!this.isBattery) {
      try {
        return this.withBaichuanRetry(async () => {
          const client = await this.ensureClient();
          return await this.takePictureInternal(client);
        });
      } catch (e) {
        this.getBaichuanLogger().error(
          "Error taking snapshot",
          e?.message || String(e),
        );
        throw e;
      }
    } else {
      const logger = this.getBaichuanLogger();
      let shouldTakeNewSnapshot = this.forceNewSnapshot;

      if (this.lastPicture) {
        const batteryUpdateIntervalMinutes =
          this.storageSettings.values.batteryUpdateIntervalMinutes ?? 60;
        const updateIntervalMs = batteryUpdateIntervalMinutes * 60_000;
        const timeSinceLastSnapshot = Date.now() - this.lastPicture.atMs;

        if (timeSinceLastSnapshot >= updateIntervalMs) {
          shouldTakeNewSnapshot = true;
          logger.log(
            `Snapshot expired: ${Math.round(timeSinceLastSnapshot / 60_000)} minutes since last snapshot (interval: ${batteryUpdateIntervalMinutes} minutes)`,
          );
        }
      }

      if (!shouldTakeNewSnapshot && this.lastPicture) {
        logger.debug(
          `Returning cached snapshot, taken at ${new Date(this.lastPicture.atMs).toLocaleString()}`,
        );
        return this.lastPicture.mo;
      }

      if (this.takePictureInFlight) {
        return await this.takePictureInFlight;
      }
      this.forceNewSnapshot = false;

      this.takePictureInFlight = (async () => {
        const client = await this.ensureClient();
        await client.wakeUp();
        const mo = await this.takePictureInternal(client);
        this.lastPicture = { mo, atMs: Date.now() };
        logger.log(
          `Snapshot taken at ${new Date(this.lastPicture.atMs).toLocaleString()}`,
        );
        return mo;
      })();

      try {
        return await this.takePictureInFlight;
      } finally {
        this.takePictureInFlight = undefined;
      }
    }
  }

  async getPictureOptions(): Promise<ResponsePictureOptions[]> {
    return [];
  }

  async updateDeviceInfo(): Promise<void> {
    const logger = this.getBaichuanLogger();

    if (this.multiFocalDevice) {
      this.info = this.multiFocalDevice.info;
      return;
    }

    const { ipAddress, rtspChannel } = this.storageSettings.values;
    try {
      const api = await this.ensureClient();
      const deviceData = await api.getInfo(
        this.nvrDevice || this.multiFocalDevice ? rtspChannel : undefined,
      );

      await updateDeviceInfo({
        device: this,
        ipAddress,
        deviceData,
        logger,
      });
    } catch (e) {
      logger.warn("Failed to fetch device info", e?.message || String(e));
    }
  }

  // Device provider methods
  async getDevice(nativeId: string): Promise<any> {
    if (nativeId.endsWith(motionSirenSuffix)) {
      this.motionSiren ||= new ReolinkCameraMotionSiren(this, nativeId);
      this.restartStatusPoll();
      return this.motionSiren;
    } else if (nativeId.endsWith(sirenSuffix)) {
      this.siren ||= new ReolinkCameraSiren(this, nativeId);
      this.restartStatusPoll();
      return this.siren;
    } else if (nativeId.endsWith(motionFloodlightSuffix)) {
      this.motionFloodlight ||= new ReolinkCameraMotionFloodlight(
        this,
        nativeId,
      );
      this.restartStatusPoll();
      return this.motionFloodlight;
    } else if (nativeId.endsWith(floodlightSuffix)) {
      this.floodlight ||= new ReolinkCameraFloodlight(this, nativeId);
      this.restartStatusPoll();
      return this.floodlight;
    } else if (nativeId.endsWith(pirSuffix)) {
      this.pirSensor ||= new ReolinkCameraPirSensor(this, nativeId);
      this.restartStatusPoll();
      return this.pirSensor;
    } else if (nativeId.endsWith(autotrackingSuffix)) {
      this.autotracking ||= new ReolinkCameraAutotracking(this, nativeId);
      this.restartStatusPoll();
      return this.autotracking;
    } else if (nativeId.endsWith(chimeSuffix)) {
      this.chime ||= new ReolinkCameraChime(this, nativeId);
      this.restartStatusPoll();
      return this.chime;
    }
  }

  async release() {
    this.statusPollTimer && clearInterval(this.statusPollTimer);
    this.sleepCheckTimer && clearInterval(this.sleepCheckTimer);
    this.batteryUpdateTimer && clearInterval(this.batteryUpdateTimer);
    this.unsubscribeFromEmailPushBus();
    this.resetBaichuanClient();
    this.plugin.camerasMap.delete(this.id);
  }

  async releaseDevice(id: string, nativeId: string): Promise<void> {
    if (nativeId.endsWith(motionSirenSuffix)) {
      this.motionSiren = undefined;
    } else if (nativeId.endsWith(sirenSuffix)) {
      this.siren = undefined;
    } else if (nativeId.endsWith(motionFloodlightSuffix)) {
      this.motionFloodlight = undefined;
    } else if (nativeId.endsWith(floodlightSuffix)) {
      this.floodlight = undefined;
    } else if (nativeId.endsWith(pirSuffix)) {
      this.pirSensor = undefined;
    } else if (nativeId.endsWith(autotrackingSuffix)) {
      this.autotracking = undefined;
    } else if (nativeId.endsWith(chimeSuffix)) {
      this.chime = undefined;
    }
  }

  async setPirEnabled(enabled: boolean): Promise<void> {
    const channel = this.storageSettings.values.rtspChannel;

    // Get current PIR settings from the sensor if available
    let sensitive: number | undefined;
    let reduceAlarm: number | undefined;
    let interval: number | undefined;

    if (this.pirSensor) {
      sensitive = this.pirSensor.storageSettings.values.sensitive;
      reduceAlarm = this.pirSensor.storageSettings.values.reduceAlarm ? 1 : 0;
      interval = this.pirSensor.storageSettings.values.interval;
    }

    await this.withBaichuanRetry(async () => {
      const api = await this.ensureClient();
      return await api.setPirInfo(channel, {
        enable: enabled ? 1 : 0,
        ...(sensitive !== undefined ? { sensitive } : {}),
        ...(reduceAlarm !== undefined ? { reduceAlarm } : {}),
        ...(interval !== undefined ? { interval } : {}),
      });
    });
  }

  /**
   * Aligns auxiliary device states (siren, floodlight, PIR, autotracking) with current API state.
   * Fetches only the states for capabilities the device has.
   * This should be called periodically for regular cameras and once when battery cameras wake up.
   * Respects cooldown periods after manual state changes to avoid overwriting user changes.
   */
  async alignAuxDevicesState(): Promise<void> {
    const logger = this.getBaichuanLogger();

    const api = await this.ensureClient();

    const channel = this.storageSettings.values.rtspChannel;
    const {
      hasSiren,
      hasFloodlight,
      hasPir,
      hasAutotracking,
      hasWirelessChime,
    } = await this.getAbilities();

    // Cooldown period: 15 seconds after a manual state change
    // Camera can take 10+ seconds to reflect state changes in its API response
    const COOLDOWN_MS = 15_000;
    const now = Date.now();

    const isInCooldown = (timestamp: number | undefined): boolean =>
      timestamp !== undefined && now - timestamp < COOLDOWN_MS;

    // Align motion-siren state
    if (hasSiren && this.motionSiren) {
      if (isInCooldown(this.auxDeviceCooldowns.motionSiren)) {
        logger.log(`[alignAuxDevicesState] Skipping motionSiren (in cooldown)`);
      } else {
        try {
          const audioTask = await api.getSirenOnMotion(channel);
          const enabled = audioTask?.body?.AudioTask?.enable === 1;
          this.motionSiren.on = enabled;
        } catch (e) {
          logger.warn(
            "Failed to align motionSiren state",
            e?.message || String(e),
          );
        }
      }
    }

    // Align siren direct-control state.
    // The siren has a built-in playback duration enforced by the camera firmware,
    // so once the audio finishes the device flips back to OFF on its own. Rely
    // on the cmd 547 (SirenStatusList) push to catch that transition; fall back
    // to an active getSirenStatus() request when no push has arrived yet so the
    // switch matches the device state after a plugin restart.
    if (hasSiren && this.siren) {
      if (isInCooldown(this.auxDeviceCooldowns.siren)) {
        logger.log(`[alignAuxDevicesState] Skipping siren (in cooldown)`);
      } else {
        try {
          const cached = api.getCachedSirenStatus(channel);
          if (cached) {
            this.siren.on =
              cached.value.status || cached.value.playing === true;
          } else {
            const status = await api.getSirenStatus({ timeoutMs: 2000 });
            const list = status?.body?.SirenStatusList;
            const playing =
              typeof list?.playing === "number" ? list.playing === 1 : false;
            const enabled =
              typeof list?.status === "number" ? list.status === 1 : false;
            this.siren.on = enabled || playing;
          }
        } catch (e) {
          logger.warn("Failed to align siren state", e?.message || String(e));
        }
      }
    }

    // Align motion-floodlight state
    if (hasFloodlight && this.motionFloodlight) {
      if (isInCooldown(this.auxDeviceCooldowns.motionFloodlight)) {
        logger.log(
          `[alignAuxDevicesState] Skipping motionFloodlight (in cooldown)`,
        );
      } else {
        try {
          const flState = await api.getFloodlightOnMotion(channel);
          this.motionFloodlight.on = flState.floodlightOnMotion;
          if (flState.brightness !== undefined) {
            this.motionFloodlight.brightness = flState.brightness;
          }
        } catch (e) {
          logger.warn(
            "Failed to align motionFloodlight state",
            e?.message || String(e),
          );
        }
      }
    }

    // Align floodlight state (direct control).
    // The camera's cmd 289 returns FloodlightTask (the scheduled task config) and
    // does NOT reflect the current manual ON/OFF — `<enable>` there is the task
    // enable, which is 0 for any camera without a configured schedule. The only
    // reliable source for the actual current state is the cmd 291 push
    // (FloodlightStatusList) that the firmware emits on every transition,
    // including the auto-off after the FloodlightManual duration expires.
    //
    // Brightness is still safe to read from cmd 289 because <brightness_cur> is
    // the persisted brightness setting and matches what the camera will apply
    // on next turnOn.
    if (hasFloodlight && this.floodlight) {
      if (isInCooldown(this.auxDeviceCooldowns.floodlight)) {
        logger.log(`[alignAuxDevicesState] Skipping floodlight (in cooldown)`);
      } else {
        try {
          const cached = api.getCachedFloodlightStatus(channel);
          if (cached) {
            this.floodlight.on = cached.value.status;
          }
          // Brightness is still meaningful from the task config.
          const ledState = await api.getWhiteLedState(channel);
          if (ledState.brightness !== undefined) {
            this.floodlight.brightness = ledState.brightness;
          }
        } catch (e) {
          logger.warn(
            "Failed to align floodlight state",
            e?.message || String(e),
          );
        }
      }
    }

    // Align PIR state
    if (hasPir && this.pirSensor) {
      if (isInCooldown(this.auxDeviceCooldowns.pir)) {
        logger.log(`[alignAuxDevicesState] Skipping pir (in cooldown)`);
      } else {
        try {
          const pirState = await api.getPirInfo(channel);
          this.pirSensor.on = pirState.enabled;
          if (pirState.state) {
            if (pirState.state.sensitive !== undefined) {
              this.pirSensor.storageSettings.values.sensitive =
                pirState.state.sensitive;
            }
            if (pirState.state.reduceAlarm !== undefined) {
              this.pirSensor.storageSettings.values.reduceAlarm =
                !!pirState.state.reduceAlarm;
            }
            if (pirState.state.interval !== undefined) {
              this.pirSensor.storageSettings.values.interval =
                pirState.state.interval;
            }
          }
        } catch (e) {
          logger.warn("Failed to align PIR state", e?.message || String(e));
        }
      }
    }

    // Align autotracking state
    if (hasAutotracking && this.autotracking) {
      if (isInCooldown(this.auxDeviceCooldowns.autotracking)) {
        logger.log(
          `[alignAuxDevicesState] Skipping autotracking (in cooldown)`,
        );
      } else {
        try {
          const autotracking = await api.getAutotracking(channel);
          this.autotracking.on = autotracking.enabled;
        } catch (e) {
          logger.warn(
            "Failed to align autotracking state",
            e?.message || String(e),
          );
        }
      }
    }

    // Align wireless chime state via getDingDongSilent (cmd 609)
    if (hasWirelessChime && this.chime) {
      if (isInCooldown(this.auxDeviceCooldowns.chime)) {
        logger.log(`[alignAuxDevicesState] Skipping chime (in cooldown)`);
      } else {
        try {
          const wirelessChimes = await api.getDingDongList(channel);
          if (wirelessChimes.length > 0) {
            const chimeId = wirelessChimes[0].id;
            this.chime.storageSettings.values.wirelessChimeId = chimeId;
            const isActive = await this.chime.syncStateFromDevice();
            if (isActive !== undefined) {
              this.chime.on = isActive;
            }
          }
        } catch (e) {
          logger.warn("Failed to align chime state", e?.message || String(e));
        }
      }
    }
  }

  // Video stream helper methods
  protected addRtspCredentials(rtspUrl: string): string {
    const logger = this.getBaichuanLogger();

    const { username, password } = this.storageSettings.values;
    if (!username) {
      return rtspUrl;
    }

    try {
      const url = new URL(rtspUrl);

      // For RTMP, add credentials as query parameters (matching reolink plugin behavior)
      // The reolink plugin uses query parameters from client.parameters (token or user/password)
      // Since we use Baichuan and don't have client.parameters, we use user/password
      if (url.protocol === "rtmp:") {
        const params = url.searchParams;
        params.set("user", username);
        params.set("password", password || "");
      } else {
        // For RTSP, add credentials in URL auth
        url.username = username;
        url.password = password || "";
      }

      return url.toString();
    } catch (e) {
      // If URL parsing fails, return original URL
      logger.warn(
        "Failed to parse URL for credentials",
        e?.message || String(e),
      );
      return rtspUrl;
    }
  }

  async getVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
    const logger = this.getBaichuanLogger();

    if (this.cachedVideoStreamOptions?.length) {
      return this.cachedVideoStreamOptions;
    }

    // If there's already a fetch in progress, return the existing promise
    if (this.fetchingStreamsPromise) {
      return this.fetchingStreamsPromise;
    }

    // Create and save the promise
    this.fetchingStreamsPromise = (async (): Promise<
      UrlMediaStreamOptions[]
    > => {
      try {
        let streams: UrlMediaStreamOptions[] = [];

        const client = await this.ensureClient();

        const { rtspChannel, variantType } = this.storageSettings.values;

        try {
          const { nativeStreams, rtmpStreams, rtspStreams, rawEncXml } =
            await client.buildVideoStreamOptions({
              onNvr: this.isOnNvr,
              channel: rtspChannel,
              compositeOnly: this.isMultiFocal,
              lens: variantType,
            });

          logger.debug(
            `Supported streams: ${JSON.stringify({
              nativeStreams: removeAuthUrls(nativeStreams),
              rtmpStreams: removeAuthUrls(rtmpStreams),
              rtspStreams: removeAuthUrls(rtspStreams),
              variantType,
              onNvr: this.isOnNvr,
              channel: rtspChannel,
              compositeOnly: this.isMultiFocal,
              rawEncXml,
            })}`,
          );

          // Update preferredStreams choices based on supported stream types
          const availableChoices = ["Default"];
          if (nativeStreams.length > 0) availableChoices.push("Native");
          if (rtspStreams.length > 0) availableChoices.push("RTSP");
          if (rtmpStreams.length > 0) availableChoices.push("RTMP");

          this.storageSettings.settings.preferredStreams.choices =
            availableChoices;

          // Update description based on default order for this camera type
          if (this.multiFocalDevice && !this.nvrDevice) {
            // Multifocal without NVR: RTSP -> RTMP -> Native
            this.storageSettings.settings.preferredStreams.description =
              "Order preference for video streams. Default: RTSP -> RTMP -> Native";
          } else {
            // Regular cameras: Native -> RTSP -> RTMP
            this.storageSettings.settings.preferredStreams.description =
              "Order preference for video streams. Default: Native -> RTSP -> RTMP";
          }

          // Order streams based on preferredStreams setting
          const preferredOrder =
            this.storageSettings.values.preferredStreams || "Default";
          let supportedStreams: ReolinkSupportedStream[] = [];

          if (preferredOrder === "Default") {
            // Default: Native -> RTSP -> RTMP
            // BUT for multifocal cameras without NVR, prefer RTSP -> RTMP -> Native
            if (this.multiFocalDevice && !this.nvrDevice) {
              supportedStreams = [
                ...rtspStreams,
                ...rtmpStreams,
                ...nativeStreams,
              ];
            } else {
              supportedStreams = [
                ...nativeStreams,
                ...rtspStreams,
                ...rtmpStreams,
              ];
            }
          } else if (preferredOrder === "Native") {
            supportedStreams = [
              ...nativeStreams,
              ...rtspStreams,
              ...rtmpStreams,
            ];
          } else if (preferredOrder === "RTSP") {
            supportedStreams = [
              ...rtspStreams,
              ...rtmpStreams,
              ...nativeStreams,
            ];
          } else if (preferredOrder === "RTMP") {
            supportedStreams = [
              ...rtmpStreams,
              ...rtspStreams,
              ...nativeStreams,
            ];
          } else {
            // Fallback to default
            supportedStreams = [
              ...rtspStreams,
              ...rtmpStreams,
              ...nativeStreams,
            ];
          }

          for (const supportedStream of supportedStreams) {
            const {
              id,
              metadata,
              url,
              name,
              container,
              lens,
              channel,
              profile,
              nativeVariant,
            } = supportedStream;

            // Composite streams are re-encoded to H.264 by the library (ffmpeg/libx264).
            // Do not infer codec from underlying camera metadata.
            const isComposite = lens === "composite" || channel === undefined;
            const codec = (() => {
              if (isComposite) return "h264";

              const enc = (metadata as any)?.videoEncType;
              // Many firmwares expose videoEncType as a numeric enum.
              // Observed: 0 => H.264, 1 => H.265.
              if (typeof enc === "number") {
                if (enc === 0) return "h264";
                if (enc === 1) return "h265";
              }

              const s = String(enc ?? "").toLowerCase();
              if (s === "0") return "h264";
              if (s === "1") return "h265";
              if (s.includes("264")) return "h264";
              if (s.includes("265")) return "h265";
              return s;
            })();

            // For RTP (native RFC4571), stream identification happens via `id` (streamKey), not URL.
            const finalUrl = url;

            streams.push({
              id,
              name,
              url: finalUrl,
              container,
              video: { codec, width: metadata.width, height: metadata.height },
              // audio: { codec: metadata.audioCodec }

              // Provide explicit RFC4571 metadata so stream-utils can avoid parsing the streamKey.
              reolinkRfc4571: {
                channel,
                profile,
                variant: nativeVariant,
              },
            } as any);
          }
        } catch (e) {
          if (!this.isRecoverableBaichuanError?.(e)) {
            logger.error(
              "Failed to build RTSP/RTMP stream options, falling back to Native",
              e?.message || String(e),
            );
          }
        }

        logger.log(
          "Fetched video stream options",
          streams.map((s) => s.name).join(", "),
        );
        logger.debug(JSON.stringify({ streams }));
        this.cachedVideoStreamOptions = streams;
        return streams;

        return [];
      } finally {
        // Always clear the promise when done (success or failure)
        this.fetchingStreamsPromise = undefined;
      }
    })();

    return this.fetchingStreamsPromise;
  }

  async getVideoStream(vso: RequestMediaStreamOptions): Promise<MediaObject> {
    if (!vso) throw new Error("video streams not set up or no longer exists.");

    const vsos = await this.getVideoStreamOptions();
    const logger = this.getBaichuanLogger();

    logger.debug(
      `Available streams: ${vsos?.map((s) => s.id).join(", ") || "none"}`,
    );
    logger.debug(`Requested stream ID: '${vso?.id}'`);

    const selected = selectStreamOption(vsos, vso);

    logger.log(`Selected stream: id='${selected.id}', url='${selected.url}'`);

    if (
      selected.url &&
      (selected.container === "rtsp" || selected.container === "rtmp")
    ) {
      const urlWithCredentials = this.addRtspCredentials(selected.url);
      const ret: MediaStreamUrl = {
        container: selected.container,
        url: urlWithCredentials,
        mediaStreamOptions: selected,
      };
      return await this.createMediaObject(
        ret,
        ScryptedMimeTypes.MediaStreamUrl,
      );
    }

    // Ensure streamManager is initialized before use
    if (!this.streamManager) {
      const logger = this.getBaichuanLogger();
      logger.warn("StreamManager not initialized, initializing now...");
      try {
        await this.initStreamManager(logger);
      } catch (e) {
        logger.error(
          "Failed to initialize StreamManager in getVideoStream",
          e?.message || String(e),
          e,
        );
        throw e;
      }
    }

    const streamKey = selected.id;
    if (!streamKey) {
      throw new Error("Missing streamKey (selected.id) for RTP stream");
    }

    logger.log(`Creating RFC4571 stream: streamKey='${streamKey}'`);

    try {
      return await this.withBaichuanRetry(async () => {
        return await createRfc4571MediaObjectFromStreamManager({
          streamManager: this.streamManager!,
          streamKey,
          selected,
          sourceId: this.id,
        });
      });
    } catch (e) {
      // If the device rejected a stream profile (e.g. ext returning 400),
      // invalidate cached stream options so the profile is excluded on the
      // next prebuffer restart cycle.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("response_code 400")) {
        this.cachedVideoStreamOptions = undefined;
        logger.warn(
          `Stream profile rejected by device (streamKey=${streamKey}). ` +
            `Cached stream options invalidated — the profile will be excluded on next refresh.`,
        );
      }
      throw e;
    }
  }

  async ensureClient(): Promise<ReolinkBaichuanApi> {
    if (this.nvrDevice) {
      return await this.nvrDevice.ensureClient();
    }
    if (this.multiFocalDevice) {
      return await this.multiFocalDevice.ensureClient();
    }

    return await this.ensureBaichuanClient();
  }

  async credentialsChanged(): Promise<void> {
    this.cachedVideoStreamOptions = undefined;
  }

  getSelectedPresetId(): number | undefined {
    const s = this.storageSettings.values.ptzSelectedPreset;
    if (!s) return undefined;

    const idPart = s.includes("=") ? s.split("=")[0] : s;
    const id = Number(idPart);
    return Number.isFinite(id) ? id : undefined;
  }

  async refreshDeviceState(): Promise<void> {
    if (this.refreshingState) {
      return;
    }
    this.refreshingState = true;

    const logger = this.getBaichuanLogger();
    const channel = this.storageSettings.values.rtspChannel;

    try {
      const { capabilities, abilities, support, presets, objects } =
        await this.withBaichuanRetry(async () => {
          const api = await this.ensureClient();
          return await api.getDeviceCapabilities(channel);
        });
      this.classes = objects;
      this.presets = presets;
      this.ptzPresets.setCachedPtzPresets(presets);

      try {
        const { interfaces, type } = getDeviceInterfaces({
          capabilities,
          logger: this.console,
          isLensDevice: !!this.multiFocalDevice,
        });

        const device: Device = {
          nativeId: this.nativeId,
          providerNativeId:
            this.nvrDevice?.nativeId ??
            this.multiFocalDevice?.nativeId ??
            this.plugin?.nativeId,
          name: this.name,
          interfaces,
          type,
          info: this.info,
        };

        await sdk.deviceManager.onDeviceDiscovered(device);

        logger.log(`Device interfaces updated`);
        logger.log(
          JSON.stringify({
            interfaces,
            isLensDevice: !!this.multiFocalDevice,
            hasNvr: !!this.nvrDevice,
            hasMultiFocal: !!this.multiFocalDevice,
            hasPlugin: !!this.plugin,
          }),
        );
        logger.debug(device);
      } catch (e) {
        logger.error(
          "Failed to update device interfaces",
          e?.message || String(e),
        );
      }

      logger.log(
        `Refreshed device capabilities: ${JSON.stringify({ capabilities, abilities, support, presets, objects })}`,
      );
    } catch (e) {
      logger.error("Failed to refresh abilities", e?.message || String(e));
    }

    this.refreshingState = false;
  }

  async init(): Promise<void> {
    const logger = this.getBaichuanLogger();

    if (this.motionDetected) {
      this.motionDetected = false;
    }

    if (!this.multiFocalDevice) {
      try {
        await this.reportDevices();
      } catch (e) {
        logger.warn(
          "Failed to report devices during init",
          e?.message || String(e),
        );
      }
    }

    this.startPeriodicTasks();

    // Subscribe to the lib's email-push bus BEFORE ensureClient so
    // SMTP motion is never lost during the api's connection window.
    // Lifetime is tied to the camera (released in `release()`) so it
    // survives every `cleanupBaichuanApi` cycle on battery cams.
    await this.subscribeToEmailPushBus();

    await this.ensureClient();

    try {
      await this.updateDeviceInfo();
    } catch (e) {
      logger.warn(
        "Failed to update device info during init",
        e?.message || String(e),
      );
    }

    try {
      await this.alignAuxDevicesState();
    } catch (e) {
      logger.warn(
        "Failed to align auxiliary devices state during init",
        e?.message || String(e),
      );
    }

    try {
      await this.refreshDeviceState();
    } catch (e) {
      logger.warn(
        "Failed to refresh device state during init",
        e?.message || String(e),
      );
    }

    if (this.isBattery && !this.multiFocalDevice) {
      await this.updateBatteryInfo();
    }

    this.storageSettings.settings.socketApiDebugLogs.hide = !!this.nvrDevice;

    this.storageSettings.settings.diagnosticsRun.hide = !!this.multiFocalDevice;
    this.storageSettings.settings.diagnosticsOutputPath.hide =
      !!this.multiFocalDevice;

    this.storageSettings.settings.enableVideoclips.hide =
      !!this.multiFocalDevice;
    this.storageSettings.settings.videoclipsDaysToPreload.hide =
      !!this.multiFocalDevice;
    this.storageSettings.settings.clearVideoclipsCache.hide =
      !!this.multiFocalDevice;
    this.storageSettings.settings.videoclipSource.hide =
      !!this.multiFocalDevice;
    this.storageSettings.settings.videoclipStreamType.hide =
      !!this.multiFocalDevice;
    this.storageSettings.settings.videoclipsRegularChecks.hide =
      !!this.multiFocalDevice;
    this.storageSettings.settings.loadVideoclips.hide = !!this.multiFocalDevice;
    this.storageSettings.settings.downloadVideoclipsLocally.hide =
      !!this.multiFocalDevice;

    this.storageSettings.settings.videoclipsRegularChecks.defaultValue = this
      .isBattery
      ? 120
      : 30;

    this.storageSettings.settings.batteryUpdateIntervalMinutes.hide =
      !this.isBattery;

    // Show PIP settings only for multifocal devices
    this.storageSettings.settings.pipPosition.hide = !this.isMultiFocal;
    this.storageSettings.settings.pipSize.hide = !this.isMultiFocal;
    this.storageSettings.settings.pipMargin.hide = !this.isMultiFocal;
    this.storageSettings.settings.compositeAssumeH264.hide = !this.isMultiFocal;
    this.storageSettings.settings.compositeDisableTranscode.hide =
      !this.isMultiFocal;
    this.storageSettings.settings.compositeVideoEncoder.hide = !this.isMultiFocal;
    this.storageSettings.settings.compositeEncoderPreset.hide =
      !this.isMultiFocal;
    this.storageSettings.settings.compositeCrf.hide = !this.isMultiFocal;
    this.storageSettings.settings.compositeGopSeconds.hide = !this.isMultiFocal;
    this.storageSettings.settings.compositeExtraGlobalArgs.hide =
      !this.isMultiFocal;
    this.storageSettings.settings.compositeExtraOutputArgs.hide =
      !this.isMultiFocal;

    const hideUid = !this.isBattery || this.isOnNvr || !!this.multiFocalDevice;
    this.storageSettings.settings.uid.hide = hideUid;
    this.storageSettings.settings.discoveryMethod.hide = hideUid;

    // E-mail Push group: only standalone cameras get the per-camera
    // SMTP knobs. NVR children share the recorder's mail path and
    // multifocal lens-children share the parent's connection — neither
    // can independently target the singleton Email Push Server, so we
    // keep the group hidden to avoid misleading the user.
    const hideEmailPush = this.isOnNvr || !!this.multiFocalDevice;
    this.storageSettings.settings.emailPushCachedStatus.hide = hideEmailPush;
    this.storageSettings.settings.emailPushTriggers.hide = hideEmailPush;
    this.storageSettings.settings.emailPushAttachment.hide = hideEmailPush;
    this.storageSettings.settings.emailPushAutoConfigure.hide = hideEmailPush;
    this.storageSettings.settings.emailPushTest.hide = hideEmailPush;
    this.storageSettings.settings.emailPushRefreshStatus.hide = hideEmailPush;
    // Show UID and discovery method for UDP cameras (battery or UDP-only like Elite Floodlight WiFi)
    // Hide for NVR children or multifocal lenses (they use parent's connection)
    // const requiresUidSettings =
    //   (this.isBattery || this.isUdpCamera) &&
    //   !this.isOnNvr &&
    //   !this.multiFocalDevice;
    // this.storageSettings.settings.uid.hide = !requiresUidSettings;
    // this.storageSettings.settings.discoveryMethod.hide = !requiresUidSettings;

    if (this.isBattery && !this.storageSettings.values.mixinsSetup) {
      try {
        const device = sdk.systemManager.getDeviceById<Settings>(this.id);
        if (device) {
          logger.log("Disabling prebuffer and snapshots from prebuffer");
          await device.putSetting("prebuffer:enabledStreams", "[]");
          await device.putSetting(
            "snapshot:snapshotsFromPrebuffer",
            "Disabled",
          );
          this.storageSettings.values.mixinsSetup = true;
        }
      } catch (e) {
        logger.warn(
          "Failed to setup mixins during init",
          e?.message || String(e),
        );
      }
    }

    try {
      await this.subscribeToEvents();
    } catch (e) {
      logger.error(
        "Failed to subscribe to Baichuan events",
        e?.message || String(e),
      );
    }

    try {
      await this.initStreamManager();
    } catch (e) {
      logger.error(
        "Failed to initialize StreamManager in init",
        e?.message || String(e),
        e,
      );
    }

    const { hasPtz } = await this.getAbilities();

    if (hasPtz) {
      const choices = (this.presets || []).map(
        (preset: any) => preset.id + "=" + preset.name,
      );

      this.storageSettings.settings.presets.choices = choices;
      this.storageSettings.settings.ptzSelectedPreset.choices = choices;

      this.storageSettings.settings.presets.hide = false;
      this.storageSettings.settings.ptzMoveDurationMs.hide = false;
      this.storageSettings.settings.ptzZoomStep.hide = false;
      this.storageSettings.settings.ptzCreatePreset.hide = false;
      this.storageSettings.settings.ptzSelectedPreset.hide = false;
      this.storageSettings.settings.ptzUpdateSelectedPreset.hide = false;
      this.storageSettings.settings.ptzDeleteSelectedPreset.hide = false;

      this.updatePtzCaps();
    }

    const parentDevice = this.nvrDevice || this.multiFocalDevice;
    if (parentDevice) {
      this.storageSettings.settings.username.hide = true;
      this.storageSettings.settings.password.hide = true;
      this.storageSettings.settings.ipAddress.hide = true;
      this.storageSettings.settings.userSessions.hide = true;
      this.storageSettings.settings.refreshUserSessions.hide = true;

      this.storageSettings.settings.username.defaultValue =
        parentDevice.storageSettings.values.username;
      this.storageSettings.settings.password.defaultValue =
        parentDevice.storageSettings.values.password;
      this.storageSettings.settings.ipAddress.defaultValue =
        parentDevice.storageSettings.values.ipAddress;
    } else {
      this.storageSettings.settings.username.hide = false;
      this.storageSettings.settings.password.hide = false;
      this.storageSettings.settings.ipAddress.hide = false;
      this.storageSettings.settings.uid.hide = false;
      this.storageSettings.settings.userSessions.hide = false;
      this.storageSettings.settings.refreshUserSessions.hide = false;
    }

    this.updateVideoClipsAutoLoad();

    this.onDeviceEvent(ScryptedInterface.Settings, "");

    try {
      await this.getVideoStreamOptions();
    } catch (e) {
      logger.error(
        "Failed to get video stream options in init",
        e?.message || String(e),
      );
    }
  }

  async updateSleepingState(sleepStatus: SleepStatus): Promise<void> {
    try {
      if (this.isDebugEnabled()) {
        this.getBaichuanLogger().debug(
          "getSleepStatus result:",
          JSON.stringify(sleepStatus),
        );
      }

      if (sleepStatus.state === "sleeping") {
        if (!this.sleeping) {
          const logger = this.getBaichuanLogger();
          logger.log(`Camera is sleeping`);
          this.sleeping = true;

          // Close all active streams and streaming sockets when camera goes to sleep
          // This ensures no sockets remain open when the camera is sleeping
          try {
            if (this.streamManager) {
              const hasActiveStreams = this.streamManager.hasActiveStreams();
              if (hasActiveStreams) {
                logger.log("Closing all active streams due to camera sleep");
                await this.streamManager.closeAllStreams("camera sleeping");
              }
            }
          } catch (e) {
            logger.error(
              "Error closing streams/sockets during sleep:",
              e?.message || String(e),
            );
          }
        }
      } else if (sleepStatus.state === "awake") {
        // Camera is awake — but DON'T do any proactive networking
        // here. Sleep inference can flicker (idle_disconnect FIN
        // packets, brief housekeeping packets from the cam, etc.),
        // and reacting to every flicker with `ensureClient + wakeUp
        // + takePicture + battery + aux state` ends up waking the cam
        // far more than the original flicker — the reconnect alone
        // re-logs in, re-subscribes events, and triggers a fresh
        // sleep/awake cycle. Real motion-triggered wake-ups arrive
        // via SMTP / native push and have their own snapshot refresh
        // path (`refreshSnapshotOnMotion`). Periodic battery polling
        // is owned by `batteryUpdateTimer` (hourly), not by sleep
        // inference. So here we only flip the local state flag.
        const wasSleeping = this.sleeping;
        if (wasSleeping) {
          this.getBaichuanLogger().log(`Camera is awake`);
          this.sleeping = false;
          if (this.forceNewSnapshot) {
            // Honor an explicit refresh requested by some other path
            // (e.g. user-triggered or capability discovery) — they
            // set `forceNewSnapshot=true` and we serve it here.
            this.takePicture().catch(() => {});
          }
        }
      } else {
        // Unknown state
        this.getBaichuanLogger().debug(
          `Sleep status unknown: ${sleepStatus.reason}`,
        );
      }
    } catch (e) {
      // Silently ignore errors in sleep check to avoid spam
      this.getBaichuanLogger().debug(
        "Error in updateSleepingState:",
        e?.message || String(e),
      );
    }
  }

  async updateOnlineState(isOnline: boolean): Promise<void> {
    try {
      if (this.isDebugEnabled()) {
        this.getBaichuanLogger().debug("updateOnlineState result:", isOnline);
      }

      if (isOnline !== this.online) {
        this.online = isOnline;
      }
    } catch (e) {
      // Silently ignore errors in sleep check to avoid spam
      this.getBaichuanLogger().debug(
        "Error in updateOnlineState:",
        e?.message || String(e),
      );
    }
  }

  async resetBaichuanClient(reason?: any): Promise<void> {
    // Delegate to cleanupBaichuanApi() which properly:
    //  - unsubscribes from events (offSimpleEvent)
    //  - calls onBeforeCleanup (closes streams, etc.)
    //  - removes close/error listeners
    //  - stops connection maintenance timers (ping, auto-renewal)
    //  - stops event check interval
    //  - uses cleanupInProgress guard to prevent races
    // Previously this method called api.close() directly, which left
    // listeners attached, timers running, and could race with the
    // close handler's own cleanupBaichuanApi() call.
    await this.cleanupBaichuanApi();

    // Ensure state is fully reset even if cleanup was a no-op
    // (e.g. baichuanApi was already undefined)
    this.connectionTime = undefined;
    this.ensureClientPromise = undefined;

    if (reason) {
      const message = reason?.message || reason?.toString?.() || reason;
      this.getBaichuanLogger().error(
        `Baichuan client reset requested: ${message}`,
      );
    }
  }

  async updateBatteryInfo(batteryInfoParent?: BatteryInfo) {
    const api = await this.ensureClient();
    const channel = this.storageSettings.values.rtspChannel;
    const logger = this.getBaichuanLogger();

    let batteryInfo = batteryInfoParent;
    if (!batteryInfo) {
      batteryInfo = await api.getBatteryInfo(channel);
    }

    if (this.isDebugEnabled()) {
      logger.debug("getBatteryInfo result:", JSON.stringify(batteryInfo));
    }

    if (batteryInfo.batteryPercent !== undefined) {
      const oldLevel = this.batteryLevel;
      const oldChargeState = this.chargeState;
      // adapterStatus: "adapter" | "solarPanel" = charging, "none" = not charging
      const isCharging =
        batteryInfo.adapterStatus === "adapter" ||
        batteryInfo.adapterStatus === "solarPanel";
      const newChargeState = isCharging
        ? ChargeState.Charging
        : ChargeState.NotCharging;

      this.batteryLevel = batteryInfo.batteryPercent;
      this.chargeState = newChargeState;

      // Log only if battery level changed
      if (oldLevel !== batteryInfo.batteryPercent) {
        logger.log(
          `Battery level changed: ${oldLevel}% → ${batteryInfo.batteryPercent}% (charging: ${isCharging}, adapter: ${batteryInfo.adapterStatus ?? "unknown"}, status: ${batteryInfo.chargeStatus ?? "unknown"})`,
        );
      } else if (oldLevel === undefined) {
        logger.log(
          `Battery level set: ${batteryInfo.batteryPercent}% (charging: ${isCharging}, adapter: ${batteryInfo.adapterStatus ?? "unknown"})`,
        );
      }

      // Forward battery/charge state changes to Scrypted (plugin, HomeKit, etc.)
      const levelChanged = oldLevel !== batteryInfo.batteryPercent;
      const chargeStateChanged =
        newChargeState !== undefined && oldChargeState !== newChargeState;
      if (levelChanged || chargeStateChanged) {
        if (levelChanged) {
          void this.onDeviceEvent(ScryptedInterface.Battery, undefined);
        }
        if (chargeStateChanged && newChargeState !== undefined) {
          void this.onDeviceEvent(ScryptedInterface.Charger, undefined);
        }
      }
    }

    return batteryInfo;
  }

  private async updateBatteryAndSnapshot(): Promise<void> {
    const logger = this.getBaichuanLogger();
    if (this.batteryUpdatePromise) {
      logger.debug(
        "Battery update already in progress, returning existing promise",
      );
      return await this.batteryUpdatePromise;
    }

    // Create and save the promise
    this.batteryUpdatePromise = (async (): Promise<void> => {
      try {
        const channel = this.storageSettings.values.rtspChannel;
        const updateIntervalMinutes =
          this.storageSettings.values.batteryUpdateIntervalMinutes ?? 10;
        logger.log(
          `Force battery update interval started (every ${updateIntervalMinutes} minutes)`,
        );

        // Ensure we have a client connection
        const api = await this.ensureClient();
        if (!api) {
          this.getBaichuanLogger().error(
            "Failed to ensure client connection for battery update",
          );
          return;
        }

        // Check current sleep status — only update if already awake
        const sleepStatus = api.getSleepStatus({ channel });

        if (sleepStatus.state === "sleeping") {
          logger.debug("Camera is sleeping, skipping periodic battery update");
          return;
        }

        this.sleeping = false;

        // Now that camera is awake, update all states
        // 1. Update battery info
        try {
          await this.updateBatteryInfo();
        } catch (e) {
          logger.error(
            "Failed to get battery info during periodic update:",
            e?.message || String(e),
          );
        }

        // 2. Align auxiliary devices state
        try {
          await this.alignAuxDevicesState();
        } catch (e) {
          logger.error(
            "Failed to align auxiliary devices state:",
            e?.message || String(e),
          );
        }

        // 3. Update snapshot
        try {
          this.forceNewSnapshot = true;
          await this.takePicture();
          logger.log("Snapshot updated during periodic update");
        } catch (snapshotError) {
          logger.error(
            "Failed to update snapshot during periodic update:",
            snapshotError?.message || String(snapshotError),
          );
        }
      } catch (e) {
        logger.error(
          "Failed to update battery and snapshot",
          e?.message || String(e),
        );
      } finally {
        // Clear the promise when done (success or failure)
        this.batteryUpdatePromise = undefined;
      }
    })();

    return await this.batteryUpdatePromise;
  }

  startPeriodicTasks(): void {
    const logger = this.getBaichuanLogger();
    if (this.periodicStarted) return;
    this.periodicStarted = true;

    logger.log("Starting periodic tasks");

    if (this.isBattery) {
      if (!this.nvrDevice && !this.multiFocalDevice) {
        this.sleepCheckTimer = setInterval(async () => {
          try {
            const api = this.baichuanApi;
            const channel = this.storageSettings.values.rtspChannel;

            if (!api) {
              if (!this.sleeping) {
                logger.log("Camera is sleeping: no active Baichuan client");
                this.sleeping = true;
              }
              return;
            }

            const sleepStatus = api.getSleepStatus({ channel });
            await this.updateSleepingState(sleepStatus);
          } catch (e) {
            logger.error(
              "Error checking sleeping state:",
              e?.message || String(e),
            );
          }
        }, 30_000);
      }

      // Update battery and snapshot every N minutes
      const { batteryUpdateIntervalMinutes = 10 } = this.storageSettings.values;
      const updateIntervalMs = batteryUpdateIntervalMinutes * 60_000;
      this.batteryUpdateTimer = setInterval(async () => {
        try {
          await this.updateBatteryAndSnapshot();
        } catch (e) {
          logger.error(
            "Error updating battery and snapshot:",
            e?.message || String(e),
          );
        }
      }, updateIntervalMs);

      logger.log(
        `Periodic tasks started: sleep check every 30s, battery update every ${batteryUpdateIntervalMinutes} minutes`,
      );
    } else {
      this.restartStatusPoll();
    }
  }

  /**
   * (Re)schedules the accessory status poll for wired cameras. The poll only
   * runs when (a) statusPollIntervalSeconds > 0 and (b) at least one accessory
   * device is actually instantiated — otherwise alignAuxDevicesState() would do
   * an ensureClient() + getAbilities() round-trip for nothing on every tick.
   * Called from startPeriodicTasks(), from the setting onPut, and after an
   * accessory child device is created (so late-created accessories get polled).
   */
  restartStatusPoll(): void {
    const logger = this.getBaichuanLogger();

    this.statusPollTimer && clearInterval(this.statusPollTimer);
    this.statusPollTimer = undefined;

    // Only relevant for wired cameras; battery cameras align on wake.
    if (this.isBattery) return;

    const { statusPollIntervalSeconds = 60 } = this.storageSettings.values;
    if (!statusPollIntervalSeconds || statusPollIntervalSeconds <= 0) {
      logger.log("Accessory status poll disabled (interval = 0)");
      return;
    }

    const hasAnyAccessory = (): boolean =>
      !!(
        this.motionSiren ||
        this.siren ||
        this.motionFloodlight ||
        this.floodlight ||
        this.pirSensor ||
        this.autotracking ||
        this.chime
      );

    if (!hasAnyAccessory()) {
      // Nothing to poll yet; restartStatusPoll() is re-invoked when an
      // accessory device is created in getDevice().
      return;
    }

    const intervalMs = statusPollIntervalSeconds * 1000;

    const run = async () => {
      // Guard inside the callback: accessories may be released between ticks.
      if (!hasAnyAccessory()) return;
      try {
        await this.alignAuxDevicesState();
      } catch (e) {
        logger.error(
          "Error aligning auxiliary devices state:",
          e?.message || String(e),
        );
      }
    };

    // Stagger the first tick so many cameras don't poll in lockstep.
    setTimeout(run, Math.random() * intervalMs);
    this.statusPollTimer = setInterval(run, intervalMs);

    logger.log(
      `Periodic tasks started: status poll every ${statusPollIntervalSeconds}s`,
    );
  }
}
