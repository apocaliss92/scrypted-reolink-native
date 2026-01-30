// Polyfill for File class if not available (required by undici in some Node.js environments)
if (typeof globalThis.File === "undefined") {
  (globalThis as any).File = class File extends Blob {
    name: string;
    lastModified: number;
    constructor(chunks: BlobPart[], name: string, options?: FilePropertyBag) {
      super(chunks, options);
      this.name = name;
      this.lastModified = options?.lastModified ?? Date.now();
    }
  };
}

import sdk, {
  DeviceCreator,
  DeviceCreatorSettings,
  DeviceProvider,
  HttpRequest,
  HttpResponse,
  MediaObject,
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  ScryptedMimeTypes,
  ScryptedNativeId,
  Setting,
  VideoClips,
} from "@scrypted/sdk";
import { BaseBaichuanClass } from "./baichuan-base";
import { ReolinkNativeMultiFocalDevice } from "./multiFocal";
import { ReolinkNativeNvrDevice } from "./nvr";
import {
  batteryCameraSuffix,
  batteryMultifocalSuffix,
  cameraSuffix,
  getDeviceInterfaces,
  handleVideoClipRequest,
  multifocalSuffix,
  nvrSuffix,
} from "./utils";
import { randomBytes } from "crypto";
import { ReolinkCamera } from "./camera";
import type { AutoDetectMode } from "@apocaliss92/reolink-baichuan-js" with {
  "resolution-mode": "import",
};

class ReolinkNativePlugin
  extends ScryptedDeviceBase
  implements DeviceProvider, DeviceCreator
{
  devices = new Map<string, BaseBaichuanClass>();
  camerasMap = new Map<string, ReolinkCamera>();
  nvrDeviceId: string;

  constructor(nativeId: string) {
    super(nativeId);

    const nvrDevice = sdk.systemManager.getDeviceByName("Scrypted NVR");
    this.nvrDeviceId = nvrDevice?.id;
  }

  getScryptedDeviceCreator(): string {
    return "Reolink Native camera";
  }

  async getDevice(nativeId: ScryptedNativeId): Promise<BaseBaichuanClass> {
    if (this.devices.has(nativeId)) {
      return this.devices.get(nativeId)!;
    }

    const newCamera = this.createCamera(nativeId);
    this.devices.set(nativeId, newCamera);
    return newCamera;
  }

  async createDevice(
    settings: DeviceCreatorSettings,
    nativeId?: string,
  ): Promise<string> {
    const ipAddress = settings.ip?.toString();
    const username = settings.username?.toString();
    const password = settings.password?.toString();
    const uid = settings.uid?.toString();

    if (!ipAddress || !username || !password) {
      throw new Error("IP address, username, and password are required");
    }

    const deviceTypeSetting = settings.deviceType?.toString() || "Auto";
    const forceType =
      deviceTypeSetting === "Auto"
        ? undefined
        : deviceTypeSetting.toLowerCase();

    this.console.log(
      `[AutoDetect] Starting device type detection for ${ipAddress}...${forceType ? ` (forcing type: ${forceType})` : ""}`,
    );
    const { autoDetectDeviceType } =
      await import("@apocaliss92/reolink-baichuan-js");
    // 'Auto', 'NVR', 'Battery Camera', 'Regular Camera
    const mode: AutoDetectMode =
      forceType === "Auto"
        ? "auto"
        : forceType === "Battery Camera"
          ? "udp"
          : forceType === "Regular Camera"
            ? "tcp"
            : forceType === "NVR"
              ? "tcp"
              : "auto";

    const maxRetries = mode === "auto" ? 2 : 10;

    const detection = await autoDetectDeviceType({
      host: ipAddress,
      username,
      password,
      uid,
      logger: this.console,
      mode,
      maxRetries,
    });
    const { ip, mac } = detection.hostNetworkInfo ?? {};

    this.console.log(
      `[AutoDetect] Detected device type: ${detection.type} (transport: ${detection.transport}). Device info: ${JSON.stringify(detection.deviceInfo)}`,
    );

    // Use the API that was successfully used for detection
    const detectedApi = detection.api;
    const deviceInfo = detection.deviceInfo || {};
    const name = deviceInfo?.name || `Reolink ${detection.type}`;
    const identifier =
      uid || mac || ip || name || randomBytes(4).toString("hex");

    // Handle multi-focal device case
    if (detection.type === "multifocal") {
      const isBattery = detection.transport === "udp";
      nativeId = `${identifier}${isBattery ? batteryMultifocalSuffix : multifocalSuffix}`;

      settings.newCamera ||= name;

      const { capabilities, objects, presets } =
        await detectedApi.getDeviceCapabilities();

      const { interfaces } = getDeviceInterfaces({
        capabilities,
        logger: this.console,
      });

      await sdk.deviceManager.onDeviceDiscovered({
        nativeId,
        name,
        interfaces,
        type: ScryptedDeviceType.DeviceProvider,
        providerNativeId: this.nativeId,
      });

      const device = await this.getDevice(nativeId);
      if (!(device instanceof ReolinkNativeMultiFocalDevice)) {
        throw new Error("Expected multi-focal device but got different type");
      }
      device.classes = objects;
      device.presets = presets;
      device.storageSettings.values.ipAddress = ipAddress;
      device.storageSettings.values.username = username;
      device.storageSettings.values.password = password;
      device.storageSettings.values.uid = uid;
      device.cachedCapabilities = capabilities;

      return nativeId;
    }

    // Handle NVR case
    if (detection.type === "nvr") {
      nativeId = `${identifier}${nvrSuffix}`;

      settings.newCamera ||= name;

      await sdk.deviceManager.onDeviceDiscovered({
        nativeId,
        name,
        interfaces: [
          ScryptedInterface.Settings,
          ScryptedInterface.DeviceDiscovery,
          ScryptedInterface.DeviceProvider,
          ScryptedInterface.Reboot,
        ],
        type: ScryptedDeviceType.DeviceProvider,
        providerNativeId: this.nativeId,
      });

      const device = await this.getDevice(nativeId);
      if (!(device instanceof ReolinkNativeNvrDevice)) {
        throw new Error("Expected NVR device but got different type");
      }
      device.storageSettings.values.ipAddress = ipAddress;
      device.storageSettings.values.username = username;
      device.storageSettings.values.password = password;

      return nativeId;
    }

    // Create nativeId based on device type
    if (detection.type === "battery-cam") {
      nativeId = `${identifier}${batteryCameraSuffix}`;
    } else {
      nativeId = `${identifier}${cameraSuffix}`;
    }

    settings.newCamera ||= name;

    // Use the API that was successfully used for detection
    try {
      const rtspChannel = 0;
      const { capabilities, objects, presets } =
        await detectedApi.getDeviceCapabilities(rtspChannel);

      const { interfaces, type } = getDeviceInterfaces({
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

      const device = (await this.getDevice(nativeId)) as ReolinkCamera;

      device.info = deviceInfo;
      device.classes = objects;
      device.presets = presets;
      device.storageSettings.values.username = username;
      device.storageSettings.values.password = password;
      device.storageSettings.values.rtspChannel = rtspChannel;
      device.storageSettings.values.ipAddress = ipAddress;
      device.storageSettings.values.uid = uid;
      device.storageSettings.values.discoveryMethod =
        detection.udpDiscoveryMethod;

      device.cachedCapabilities = capabilities;

      return nativeId;
    } catch (e) {
      this.console.error(
        "Error adding Reolink device",
        e?.message || String(e),
      );
      throw e;
    }
  }

  async releaseDevice(id: string, nativeId: ScryptedNativeId): Promise<void> {
    if (this.devices.has(nativeId)) {
      const device = this.devices.get(nativeId);
      if (
        device &&
        "release" in device &&
        typeof device.release === "function"
      ) {
        await device.release();
      }
      this.devices.delete(nativeId);
    }
  }

  async getCreateDeviceSettings(): Promise<Setting[]> {
    return [
      {
        key: "ip",
        title: "IP Address",
        placeholder: "192.168.2.222",
        value: "192.168.",
      },
      {
        key: "username",
        title: "Username",
        value: "admin",
      },
      {
        key: "password",
        title: "Password",
        type: "password",
      },
      {
        key: "uid",
        title: "UID",
        description:
          "Reolink UID (optional, required for battery cameras if TCP connection fails)",
      },
      {
        key: "deviceType",
        title: "Device Type",
        description:
          'Device type detection mode. Use "Auto" for automatic detection, or force a specific type.',
        type: "string",
        choices: ["Auto", "NVR", "Battery Camera", "Regular Camera"],
        value: "Auto",
      },
    ];
  }

  createCamera(nativeId: string) {
    if (nativeId.endsWith(batteryCameraSuffix)) {
      return new ReolinkCamera(nativeId, this, { type: "battery" });
    } else if (nativeId.endsWith(nvrSuffix)) {
      return new ReolinkNativeNvrDevice(nativeId, this);
    } else if (nativeId.endsWith(batteryMultifocalSuffix)) {
      return new ReolinkNativeMultiFocalDevice(
        nativeId,
        this,
        "multi-focal-battery",
      );
    } else if (nativeId.endsWith(multifocalSuffix)) {
      return new ReolinkNativeMultiFocalDevice(nativeId, this, "multi-focal");
    } else {
      return new ReolinkCamera(nativeId, this, { type: "regular" });
    }
  }

  async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
    const logger = this.console;
    const url = new URL(`http://localhost${request.url}`);

    try {
      // Parse webhook path: /.../webhook/{type}/{deviceId}/{fileId}
      // The path may include prefix like /endpoint/@apocaliss92/scrypted-reolink-native/public/webhook/...
      const pathParts = url.pathname.split("/").filter((p) => p);

      // Find the index of 'webhook' in the path
      const webhookIndex = pathParts.indexOf("webhook");
      if (webhookIndex === -1 || pathParts.length < webhookIndex + 4) {
        response.send("Invalid webhook path", { code: 404 });
        return;
      }

      // Extract type, deviceId, and fileId after 'webhook'
      const type = pathParts[webhookIndex + 1];
      const encodedDeviceId = pathParts[webhookIndex + 2];
      // fileId may contain slashes, so join all remaining parts
      const encodedFileId = pathParts.slice(webhookIndex + 3).join("/");
      const deviceId = decodeURIComponent(encodedDeviceId);
      let fileId = decodeURIComponent(encodedFileId);

      // Restore leading slash if the original fileId had it (we removed it during encoding)
      // The API expects fileId with leading slash for absolute paths
      if (!fileId.startsWith("/") && !fileId.startsWith("http")) {
        // If it looks like an absolute path (starts with common path prefixes), add slash
        if (
          fileId.startsWith("mnt/") ||
          fileId.startsWith("var/") ||
          fileId.startsWith("tmp/")
        ) {
          fileId = `/${fileId}`;
        }
      }

      // logger.log(`Webhook request: type=${type}, deviceId=${deviceId}, fileId=${fileId}`);

      // Get the device
      const device = this.camerasMap.get(deviceId);
      if (!device) {
        response.send("Device not found", { code: 404 });
        return;
      }

      if (type === "video") {
        // Use handleVideoClipRequest for all clients (including iOS)
        // It will use HTTP download with chunks which works on all platforms
        await handleVideoClipRequest({
          device,
          deviceId,
          fileId,
          request,
          response,
          logger,
        });
        return;
      } else if (type === "thumbnail") {
        // Get thumbnail MediaObject
        const mo = await device.getVideoClipThumbnail(fileId);

        // Convert to buffer
        const buffer = await sdk.mediaManager.convertMediaObjectToBuffer(
          mo,
          "image/jpeg",
        );

        // Send image
        response.send(buffer, {
          code: 200,
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "max-age=31536000",
          },
        });
        return;
      } else {
        response.send("Invalid webhook type", { code: 404 });
        return;
      }
    } catch (e: any) {
      logger.error("Error in onRequest", e?.message || String(e));
      response.send(`Error: ${e.message}`, {
        code: 500,
      });
      return;
    }
  }

  onPush(request: HttpRequest): Promise<void> {
    return this.onRequest(request, undefined);
  }
}

export default ReolinkNativePlugin;
