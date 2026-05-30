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

import type {
  AutoDetectMode,
  ReolinkBaichuanApi,
} from "@apocaliss92/nodelink-js" with {
  "resolution-mode": "import",
};
import sdk, {
  DeviceCreator,
  DeviceCreatorSettings,
  DeviceProvider,
  HttpRequest,
  HttpResponse,
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  ScryptedNativeId,
  Setting,
  Settings,
} from "@scrypted/sdk";
import { randomBytes } from "crypto";
import { BaseBaichuanClass } from "./baichuan-base";
import { ReolinkCamera } from "./camera";
import {
  createBaichuanApi,
  normalizeUid,
  type BaichuanTransport,
} from "./connect";
import {
  EMAIL_PUSH_SERVER_NATIVE_ID,
  EmailPushServerDevice,
} from "./email-push-server-device";
import {
  INTERCOM_PROVIDER_NATIVE_ID,
  ReolinkNativeIntercom,
} from "./intercom-provider";
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
  udpCameraSuffix,
  udpMultifocalSuffix,
} from "./utils";

class ReolinkNativePlugin
  extends ScryptedDeviceBase
  implements DeviceProvider, DeviceCreator, Settings
{
  devices = new Map<string, BaseBaichuanClass>();
  camerasMap = new Map<string, ReolinkCamera>();
  nvrDeviceId: string;
  private intercomProvider?: ReolinkNativeIntercom;
  // Public so `ReolinkCamera` can call the device's
  // `getManagerSetupParamsForCamera()` when the user clicks
  // "Auto-configure from Email Push Server" on the camera page.
  // May be undefined until `getDevice(EMAIL_PUSH_SERVER_NATIVE_ID)`
  // is invoked at least once — callers materialise it via
  // `await plugin.getDevice(EMAIL_PUSH_SERVER_NATIVE_ID)`.
  emailPushServer?: EmailPushServerDevice;
  // private networkDiscoveredDevices = new Map<string, { discovered: DiscoveredDevice; libDevice: LibDiscoveredDevice }>();
  // private discoverDevicesPromise: Promise<DiscoveredDevice[]> | undefined;
  // private autodiscoveryClient: AutodiscoveryClient | undefined;

  // Shared Baichuan API connections for external devices (non-Reolink Native cameras).
  // Keyed by Scrypted device ID. Multiple mixins on the same device share one connection.
  private externalClients = new Map<
    string,
    { api: ReolinkBaichuanApi; refCount: number }
  >();

  constructor(nativeId: string) {
    super(nativeId);

    const nvrDevice = sdk.systemManager.getDeviceByName("Scrypted NVR");
    this.nvrDeviceId = nvrDevice?.id;

    // Register the intercom MixinProvider as a sub-device
    sdk.deviceManager.onDeviceDiscovered({
      nativeId: INTERCOM_PROVIDER_NATIVE_ID,
      name: "Reolink Native Intercom",
      interfaces: [ScryptedInterface.MixinProvider, ScryptedInterface.Settings],
      type: ScryptedDeviceType.API,
      providerNativeId: this.nativeId,
    });

    sdk.deviceManager.onDeviceDiscovered({
      nativeId: EMAIL_PUSH_SERVER_NATIVE_ID,
      name: "Reolink E-mail Push Server",
      interfaces: [ScryptedInterface.Settings, ScryptedInterface.Online],
      type: ScryptedDeviceType.API,
      providerNativeId: this.nativeId,
    });

    // Start background autodiscovery
    // this.startBackgroundDiscovery();
  }

  // private async startBackgroundDiscovery() {
  //   const { AutodiscoveryClient: AutodiscoveryClientClass } = await import("@apocaliss92/nodelink-js");

  //   // Stop previous client if settings changed
  //   this.autodiscoveryClient?.stop();

  //   const methods: string[] = JSON.parse(this.storage.getItem("discoveryMethods") || '["arp","onvif"]');
  //   const subnetsRaw = this.storage.getItem("discoverySubnets") || "";
  //   const subnets = subnetsRaw.split(",").map((s: string) => s.trim()).filter(Boolean);

  //   this.autodiscoveryClient = new AutodiscoveryClientClass({
  //     enableHttpScanning: methods.includes("http"),
  //     enableUdpDiscovery: methods.includes("udp"),
  //     enableTcpPortScan: methods.includes("tcp"),
  //     enableArpLookup: methods.includes("arp"),
  //     enableDhcpListener: methods.includes("dhcp"),
  //     enableOnvifDiscovery: methods.includes("onvif"),
  //     logger: this.console,
  //     httpProbeTimeoutMs: 3000,
  //     udpBroadcastTimeoutMs: 5000,
  //     tcpProbeTimeoutMs: 1500,
  //     dhcpListenerTimeoutMs: 10000,
  //     scanIntervalMs: 120_000, // 2 minutes
  //     autoStart: true,
  //     ...(subnets.length > 0 ? { networkCidr: subnets[0] } : {}),
  //     onDeviceDiscovered: (libDevice) => {
  //       this.handleBackgroundDiscovery(libDevice);
  //     },
  //   });
  // }

  // private handleBackgroundDiscovery(libDevice: LibDiscoveredDevice) {
  //   const existingIps = this.getExistingDeviceIps();
  //   if (existingIps.has(libDevice.host)) return;

  //   const nativeId = `discovered-${libDevice.host}`;
  //   if (this.networkDiscoveredDevices.has(nativeId)) return;

  //   this.addToDiscoveryList(libDevice);
  //   this.console.log(`[Discovery] Background: new device ${libDevice.host} (${libDevice.name || libDevice.model || "unknown"})`);

  //   // Notify Scrypted of updated discovery list
  //   this.onDeviceEvent(
  //     ScryptedInterface.DeviceDiscovery,
  //     [...this.networkDiscoveredDevices.values()].map((d) => d.discovered),
  //   );
  // }

  async acquireExternalClient(
    deviceId: string,
    config: {
      host: string;
      username: string;
      password: string;
      uid?: string;
      transport: BaichuanTransport;
      logger?: Console;
    },
  ): Promise<ReolinkBaichuanApi> {
    const existing = this.externalClients.get(deviceId);
    if (existing?.api?.isReady) {
      existing.refCount++;
      return existing.api;
    }
    // Close stale client if any
    if (existing?.api) {
      try {
        await existing.api.close();
      } catch {}
    }
    const api = await createBaichuanApi({
      inputs: {
        host: config.host,
        username: config.username,
        password: config.password,
        uid: normalizeUid(config.uid),
        logger: config.logger,
      },
      transport: config.transport,
    });
    this.externalClients.set(deviceId, { api, refCount: 1 });
    return api;
  }

  async releaseExternalClient(deviceId: string): Promise<void> {
    const entry = this.externalClients.get(deviceId);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      this.externalClients.delete(deviceId);
      try {
        await entry.api.close();
      } catch {}
    }
  }

  getScryptedDeviceCreator(): string {
    return "Reolink Native camera";
  }

  async getDevice(nativeId: ScryptedNativeId): Promise<any> {
    if (nativeId === INTERCOM_PROVIDER_NATIVE_ID) {
      if (!this.intercomProvider) {
        this.intercomProvider = new ReolinkNativeIntercom(nativeId);
        this.intercomProvider.plugin = this;
      }
      return this.intercomProvider;
    }

    if (nativeId === EMAIL_PUSH_SERVER_NATIVE_ID) {
      if (!this.emailPushServer) {
        this.emailPushServer = new EmailPushServerDevice(nativeId);
        this.emailPushServer.plugin = this;
        // Fire-and-forget: starts the SMTP server if enabled in storage.
        void this.emailPushServer.start().catch((e: unknown) => {
          this.console.error(
            `Email push server start failed: ${e instanceof Error ? e.message : e}`,
          );
        });
      }
      return this.emailPushServer;
    }

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
    const { autoDetectDeviceType } = await import("@apocaliss92/nodelink-js");
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
      // Determine suffix based on transport and battery capability
      // UDP transport does NOT always mean battery (e.g., some floodlight cameras use UDP but are AC-powered)
      const isUdp = detection.transport === "udp";

      // Get capabilities to check if device has battery
      const { capabilities, objects, presets } =
        await detectedApi.getDeviceCapabilities();

      const hasBattery = capabilities?.hasBattery === true;

      // Choose suffix based on transport and battery
      if (isUdp) {
        nativeId = `${identifier}${hasBattery ? batteryMultifocalSuffix : udpMultifocalSuffix}`;
      } else {
        nativeId = `${identifier}${multifocalSuffix}`;
      }

      settings.newCamera ||= name;

      const { interfaces } = getDeviceInterfaces({
        capabilities,
        logger: this.console,
      });

      const deviceId = await sdk.deviceManager.onDeviceDiscovered({
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

      return deviceId;
    }

    // Handle NVR case
    if (detection.type === "nvr") {
      nativeId = `${identifier}${nvrSuffix}`;

      settings.newCamera ||= name;

      const deviceId = await sdk.deviceManager.onDeviceDiscovered({
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

      return deviceId;
    }

    // Create nativeId based on device type and transport
    // UDP transport does NOT always mean battery (e.g., Elite Floodlight WiFi uses UDP but is AC-powered)
    const isUdp = detection.transport === "udp";
    if (detection.type === "battery-cam") {
      // Battery camera (always UDP)
      nativeId = `${identifier}${batteryCameraSuffix}`;
    } else if (isUdp) {
      // UDP camera without battery (e.g., Elite Floodlight WiFi)
      nativeId = `${identifier}${udpCameraSuffix}`;
    } else {
      // Regular TCP camera
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

      const deviceId = await sdk.deviceManager.onDeviceDiscovered({
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

      return deviceId;
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

  /**
   * Collect IP addresses of all existing devices managed by this plugin.
   */
  private getExistingDeviceIps(): Set<string> {
    const ips = new Set<string>();
    for (const [, device] of this.devices) {
      const ip = (device as any).storageSettings?.values?.ipAddress;
      if (ip) ips.add(ip);
    }
    // Also check storage for devices not yet instantiated
    const nativeIds = sdk.deviceManager.getNativeIds().filter((nid) => !!nid);
    for (const nid of nativeIds) {
      try {
        const storage = sdk.deviceManager.getDeviceStorage(nid);
        const ip = storage?.getItem("ipAddress");
        if (ip) ips.add(ip);
      } catch {
        // ignore
      }
    }
    return ips;
  }

  // async discoverDevices(scan?: boolean): Promise<DiscoveredDevice[]> {
  //   if (scan) {
  //     if (this.discoverDevicesPromise) {
  //       return await this.discoverDevicesPromise;
  //     }
  //     this.discoverDevicesPromise = (async () => {
  //       try {
  //         // Trigger immediate scan on the background client
  //         if (this.autodiscoveryClient) {
  //           await this.autodiscoveryClient.scanNow();
  //         }

  //         // Rebuild the discovery list from the client's cumulative results
  //         this.rebuildDiscoveryList();

  //         return [...this.networkDiscoveredDevices.values()].map((d) => d.discovered);
  //       } catch (e: any) {
  //         this.console.error(`[Discovery] Scan failed: ${e?.message || String(e)}`);
  //         return [];
  //       } finally {
  //         this.discoverDevicesPromise = undefined;
  //       }
  //     })();
  //     return await this.discoverDevicesPromise;
  //   }

  //   // No scan: return cached results
  //   return [...this.networkDiscoveredDevices.values()].map((d) => d.discovered);
  // }

  // private rebuildDiscoveryList() {
  //   const existingIps = this.getExistingDeviceIps();
  //   const allDevices = this.autodiscoveryClient?.getDiscoveredDevices() ?? [];
  //   this.networkDiscoveredDevices.clear();

  //   for (const libDevice of allDevices) {
  //     const alreadyAdded = existingIps.has(libDevice.host);
  //     this.console.log(`[Discovery] Found ${libDevice.host} (${libDevice.name || libDevice.model || "unknown"})${alreadyAdded ? " — already added, skipping" : ""}`);
  //     if (alreadyAdded) continue;
  //     this.addToDiscoveryList(libDevice);
  //   }

  //   this.console.log(`[Discovery] ${this.networkDiscoveredDevices.size} new device(s), ${existingIps.size} already added`);
  // }

  // private addToDiscoveryList(libDevice: LibDiscoveredDevice) {
  //   const nativeId = `discovered-${libDevice.host}`;
  //   const name = libDevice.name || libDevice.model || `Reolink ${libDevice.host}`;
  //   const descParts: string[] = [libDevice.host];
  //   if (libDevice.model) descParts.push(libDevice.model);
  //   if (libDevice.uid) descParts.push(`UID: ${libDevice.uid}`);

  //   const discovered: DiscoveredDevice = {
  //     nativeId,
  //     name,
  //     description: descParts.join(" — "),
  //     type: ScryptedDeviceType.Camera,
  //     settings: [
  //       { key: "username", title: "Username", value: "admin" },
  //       { key: "password", title: "Password", type: "password" },
  //     ],
  //   };

  //   if (libDevice.firmwareVersion || libDevice.model) {
  //     discovered.info = {
  //       manufacturer: "Reolink",
  //       ...(libDevice.model ? { model: libDevice.model } : {}),
  //       ...(libDevice.firmwareVersion ? { firmware: libDevice.firmwareVersion } : {}),
  //     };
  //   }

  //   this.networkDiscoveredDevices.set(nativeId, { discovered, libDevice });
  // }

  // async adoptDevice(adopt: AdoptDevice): Promise<string> {
  //   const entry = this.networkDiscoveredDevices.get(adopt.nativeId);
  //   if (!entry) throw new Error("Device not found in discovery cache");

  //   const { libDevice } = entry;
  //   const username = adopt.settings?.username?.toString() || "admin";
  //   const password = adopt.settings?.password?.toString();
  //   if (!password) throw new Error("Password is required");

  //   // Delegate to createDevice which handles auto-detection, capabilities, etc.
  //   const nativeId = await this.createDevice({
  //     ip: libDevice.host,
  //     username,
  //     password,
  //     uid: libDevice.uid || "",
  //     deviceType: "Auto",
  //   });

  //   // Remove from discovered cache
  //   this.networkDiscoveredDevices.delete(adopt.nativeId);

  //   // Notify Scrypted of updated discovery list
  //   await this.onDeviceEvent(
  //     ScryptedInterface.DeviceDiscovery,
  //     [...this.networkDiscoveredDevices.values()].map((d) => d.discovered),
  //   );

  //   return nativeId;
  // }

  async getSettings(): Promise<Setting[]> {
    return [
      // {
      //   key: "discoveryMethods",
      //   title: "Discovery Methods",
      //   description: "ARP: reads ARP table for Reolink MAC prefixes (fast, like Home Assistant). ONVIF: WS-Discovery multicast (most Reolink cameras). DHCP: passive listener on port 67 (requires root).",
      //   type: "string",
      //   choices: ["arp", "onvif", "dhcp"],
      //   multiple: true,
      //   value: JSON.parse(this.storage.getItem("discoveryMethods") || '["arp","onvif"]'),
      // },
      // {
      //   key: "discoverySubnets",
      //   title: "Discovery Subnets",
      //   description: "Comma-separated list of subnets to scan in CIDR notation (e.g. 192.168.1.0/24, 10.0.0.0/24). Leave empty to auto-detect the local network. Used for HTTP and TCP scanning; ARP/UDP/DHCP methods don't need this.",
      //   type: "string",
      //   placeholder: "192.168.1.0/24, 10.0.0.0/24",
      //   value: this.storage.getItem("discoverySubnets") || "",
      // },
    ];
  }

  async putSetting(
    key: string,
    value: string | number | boolean | string[],
  ): Promise<void> {
    if (Array.isArray(value)) {
      this.storage.setItem(key, JSON.stringify(value));
    } else {
      this.storage.setItem(key, String(value));
    }

    // Restart background discovery when discovery settings change
    // if (key === "discoveryMethods" || key === "discoverySubnets") {
    //   this.startBackgroundDiscovery();
    // }
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
    } else if (nativeId.endsWith(udpMultifocalSuffix)) {
      // UDP multifocal without battery
      return new ReolinkNativeMultiFocalDevice(
        nativeId,
        this,
        "multi-focal-udp",
      );
    } else if (nativeId.endsWith(multifocalSuffix)) {
      return new ReolinkNativeMultiFocalDevice(nativeId, this, "multi-focal");
    } else if (nativeId.endsWith(udpCameraSuffix)) {
      // UDP camera without battery (e.g., Elite Floodlight WiFi)
      return new ReolinkCamera(nativeId, this, { type: "udp" });
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
