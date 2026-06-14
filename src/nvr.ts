import type {
  ReolinkBaichuanApi,
  ReolinkBaichuanDeviceSummary,
  ReolinkSimpleEvent,
} from "@apocaliss92/nodelink-js" with { "resolution-mode": "import" };
import sdk, {
  AdoptDevice,
  Device,
  DeviceDiscovery,
  DeviceProvider,
  DiscoveredDevice,
  Reboot,
  ScryptedDeviceType,
  ScryptedInterface,
  Setting,
  Settings,
  SettingValue,
} from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import {
  BaseBaichuanClass,
  type BaichuanConnectionCallbacks,
  type BaichuanConnectionConfig,
} from "./baichuan-base";
import { ReolinkCamera } from "./camera";
import {
  convertDebugLogsToApiOptions,
  getApiRelevantDebugLogs,
  getDebugLogChoices,
} from "./debug-options";
import ReolinkNativePlugin from "./main";
import { ReolinkNativeMultiFocalDevice } from "./multiFocal";
import {
  batteryCameraSuffix,
  batteryMultifocalSuffix,
  cameraSuffix,
  getDeviceInterfaces,
  multifocalSuffix,
  updateDeviceInfo,
} from "./utils";

export class ReolinkNativeNvrDevice
  extends BaseBaichuanClass
  implements Settings, DeviceDiscovery, DeviceProvider, Reboot
{
  private readonly onSimpleEventBound = (ev: ReolinkSimpleEvent) =>
    this.onSimpleEvent(ev);

  storageSettings = new StorageSettings(this, {
    debugLogs: {
      title: "Debug Events",
      type: "boolean",
      immediate: true,
      onPut: async (ov, value) => {
        if (ov === value) return;
        const logger = this.getBaichuanLogger();
        if (this.debugLogsResetTimeout) {
          clearTimeout(this.debugLogsResetTimeout);
          this.debugLogsResetTimeout = undefined;
        }
        this.debugLogsResetTimeout = setTimeout(async () => {
          this.debugLogsResetTimeout = undefined;
          try {
            await this.cleanupBaichuanApi();
            await this.ensureBaichuanClient();
          } catch (e) {
            logger.warn(
              "Failed to reset client after debug logs change",
              e?.message || String(e),
            );
          }
        }, 2000);
      },
    },
    // eventSource: {
    //     title: 'Event Source',
    //     description: 'Select the source for camera events: Native (Baichuan) or CGI (HTTP polling)',
    //     type: 'string',
    //     choices: ['Native', 'CGI'],
    //     defaultValue: 'Native',
    //     immediate: true,
    //     onPut: async () => {
    //         await this.reinitEventSubscriptions();
    //     }
    // },
    ipAddress: {
      title: "IP address",
      type: "string",
      onPut: async () => await this.reinit(),
    },
    username: {
      title: "Username",
      placeholder: "admin",
      defaultValue: "admin",
      type: "string",
      onPut: async () => await this.reinit(),
    },
    password: {
      title: "Password",
      type: "password",
      onPut: async () => await this.reinit(),
    },
    diagnosticsRun: {
      subgroup: "Advanced",
      title: "Run Diagnostics",
      description: "Collect NVR diagnostics and display results in logs.",
      type: "button",
      immediate: true,
      onPut: async () => {
        await this.runNvrDiagnostics();
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
        if (changed) {
          // Clear any existing timeout
          if (this.debugLogsResetTimeout) {
            clearTimeout(this.debugLogsResetTimeout);
            this.debugLogsResetTimeout = undefined;
          }

          this.debugLogsResetTimeout = setTimeout(async () => {
            this.debugLogsResetTimeout = undefined;
            try {
              await this.cleanupBaichuanApi();
              await this.ensureBaichuanClient();
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
    userSessions: {
      title: "Active User Sessions",
      subgroup: "Sessions",
      description:
        "List of currently active user sessions connected to the device via Baichuan socket. Click 'Refresh Sessions' to update.",
      type: "string",
      multiple: true,
      combobox: false,
      readonly: true,
      hide: false,
      defaultValue: [],
    },
    refreshUserSessions: {
      title: "Refresh Sessions",
      subgroup: "Sessions",
      description: "Refresh the list of active user sessions from the device.",
      type: "button",
      immediate: true,
      hide: false,
      onPut: async () => {
        await this.refreshUserSessionsList();
      },
    },
  });
  plugin: ReolinkNativePlugin;
  discoveredDevices = new Map<
    string,
    {
      device: Device;
      description: string;
      rtspChannel: number;
      deviceData: ReolinkBaichuanDeviceSummary;
    }
  >();
  cameraNativeMap = new Map<string, ReolinkCamera>();
  private channelToNativeIdMap = new Map<number, string>();
  private discoverDevicesPromise: Promise<DiscoveredDevice[]> | undefined;
  processing = false;
  private initReinitTimeout: NodeJS.Timeout | undefined;
  private debugLogsResetTimeout: NodeJS.Timeout | undefined;

  constructor(nativeId: string, plugin: ReolinkNativePlugin) {
    super(nativeId, "tcp");
    this.plugin = plugin;

    this.scheduleInit();
  }

  async reboot(): Promise<void> {
    const api = await this.ensureBaichuanClient();
    await api.reboot();
  }

  protected getConnectionConfig(): BaichuanConnectionConfig {
    const { ipAddress, username, password } = this.storageSettings.values;
    if (!ipAddress || !username || !password) {
      throw new Error("Missing NVR credentials");
    }

    const debugOptions = this.getBaichuanDebugOptions();

    return {
      host: ipAddress,
      username,
      password,
      transport: "tcp",
      debugOptions,
    };
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

  protected getConnectionCallbacks(): BaichuanConnectionCallbacks {
    return {
      onClose: async () => {
        await this.reinit();
      },
      onSimpleEvent: this.onSimpleEventBound,
      getEventSubscriptionEnabled: () => true,
    };
  }

  protected isNvrDevice(): boolean {
    return true; // NVR/Hub always returns true
  }

  protected isDebugEnabled(): boolean {
    return this.storageSettings.values.debugLogs || false;
  }

  protected getDeviceName(): string {
    return this.name || "NVR";
  }

  protected async onBeforeCleanup(): Promise<void> {
    await this.unsubscribeFromEvents();
  }

  async reinit() {
    if (this.initReinitTimeout) {
      clearTimeout(this.initReinitTimeout);
      this.initReinitTimeout = undefined;
    }

    this.scheduleInit(true);
  }

  private scheduleInit(isReinit: boolean = false): void {
    // Cancel any pending init/reinit
    if (this.initReinitTimeout) {
      clearTimeout(this.initReinitTimeout);
    }

    this.initReinitTimeout = setTimeout(
      async () => {
        if (isReinit) {
          await super.cleanupBaichuanApi();
        }
        await this.init();
        this.initReinitTimeout = undefined;
      },
      isReinit ? 500 : 2000,
    );
  }

  onSimpleEvent(ev: ReolinkSimpleEvent) {
    const logger = this.getBaichuanLogger();

    try {
      logger.debug("Baichuan event on nvr:", ev);

      const channel = ev?.channel;
      if (channel === undefined) {
        logger.error("Event has no channel, ignoring");
        return;
      }

      const nativeId = this.channelToNativeIdMap.get(channel);
      const targetDevice = nativeId
        ? this.cameraNativeMap.get(nativeId)
        : undefined;

      if (!targetDevice) {
        logger.debug(
          `No device found for channel ${channel} (nativeId: ${nativeId}), ignoring event`,
        );
        return;
      }

      targetDevice.onSimpleEvent(ev);
    } catch (e) {
      logger.warn(
        "Error in NVR Native event forwarder",
        e?.message || String(e),
      );
    }
  }

  async ensureBaichuanClient(): Promise<ReolinkBaichuanApi> {
    return await super.ensureBaichuanClient();
  }

  async ensureClient(): Promise<ReolinkBaichuanApi> {
    return await this.ensureBaichuanClient();
  }

  private async runNvrDiagnostics(): Promise<void> {
    const logger = this.getBaichuanLogger();
    logger.log(`Starting NVR diagnostics...`);

    try {
      const api = await this.ensureBaichuanClient();

      await api.collectNvrDiagnostics({
        logger: this.console,
      });
    } catch (e) {
      logger.error("Failed to run NVR diagnostics", e?.message || String(e));
      throw e;
    }
  }

  async init() {
    await this.ensureBaichuanClient();
    await this.subscribeToEvents();
    const discovered = await this.discoverDevices(true);
    if (discovered.length > 0) {
      await this.onDeviceEvent(ScryptedInterface.DeviceDiscovery, discovered);
    }

    await this.updateDeviceInfo();
  }

  async updateDeviceInfo(): Promise<void> {
    const logger = this.getBaichuanLogger();

    const { ipAddress } = this.storageSettings.values;
    try {
      const api = await this.ensureBaichuanClient();
      const deviceData = await api.getInfo();

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

  async getSettings(): Promise<Setting[]> {
    const settings = await this.storageSettings.getSettings();
    return settings;
  }

  async putSetting(key: string, value: SettingValue): Promise<void> {
    return this.storageSettings.putSetting(key, value);
  }

  async releaseDevice(id: string, nativeId: string) {
    this.cameraNativeMap.delete(nativeId);
  }

  async getDevice(nativeId: string): Promise<ReolinkCamera> {
    let device = this.cameraNativeMap.get(nativeId);

    if (!device) {
      if (nativeId.endsWith(batteryCameraSuffix)) {
        device = new ReolinkCamera(nativeId, this.plugin, {
          type: "battery",
          nvrDevice: this,
        });
      } else if (nativeId.endsWith(batteryMultifocalSuffix)) {
        device = new ReolinkNativeMultiFocalDevice(
          nativeId,
          this.plugin,
          "multi-focal-battery",
          this,
        );
      } else if (nativeId.endsWith(multifocalSuffix)) {
        device = new ReolinkNativeMultiFocalDevice(
          nativeId,
          this.plugin,
          "multi-focal",
          this,
        );
      } else {
        device = new ReolinkCamera(nativeId, this.plugin, {
          type: "regular",
          nvrDevice: this,
        });
      }

      if (device) {
        this.cameraNativeMap.set(nativeId, device);
      }
    }

    return device;
  }

  buildNativeId(props: {
    identifier?: string;
    isBattery?: boolean;
    isMultifocal?: boolean;
  }): string {
    const { identifier, isBattery, isMultifocal } = props;

    const suffix = isBattery
      ? isMultifocal
        ? batteryMultifocalSuffix
        : batteryCameraSuffix
      : isMultifocal
        ? multifocalSuffix
        : cameraSuffix;

    return `${this.nativeId}-${identifier}${suffix}`;
  }

  getCameraInterfaces() {
    return [
      ScryptedInterface.VideoCameraConfiguration,
      ScryptedInterface.Camera,
      ScryptedInterface.MotionSensor,
      ScryptedInterface.VideoTextOverlays,
      ScryptedInterface.VideoCamera,
      ScryptedInterface.Settings,
      ScryptedInterface.ObjectDetector,
    ];
  }

  async syncEntitiesFromRemote(attempt = 0) {
    const logger = this.getBaichuanLogger();
    // const { ipAddress } = this.storageSettings.values;

    const api = await this.ensureBaichuanClient();
    // Prefer CGI (HTTP GetChannelstatus): it returns the channel list
    // immediately, without depending on the async cmd_id 145 Baichuan push.
    // But some Home Hub models expose no HTTP API at all (issue #15): CGI
    // then fails fast (connection refused), so we fall back to HTTP-free
    // Baichuan discovery, which probes the Support-advertised channel slots.
    let result: Awaited<ReturnType<typeof api.getNvrChannelsSummary>>;
    try {
      result = await api.getNvrChannelsSummary({ source: "cgi" });
      if (!result.channels.length) {
        throw new Error("CGI returned no channels");
      }
    } catch (e) {
      logger.debug(
        `CGI channel discovery unavailable (${(e as Error)?.message}); falling back to Baichuan`,
      );
      result = await api.getNvrChannelsSummary({ source: "baichuan" });
    }
    const { devices, channels } = result;

    if (!channels.length) {
      const maxAttempts = 5;
      if (attempt >= maxAttempts) {
        logger.warn(
          `No channels found after ${attempt + 1} attempts; giving up for now`,
        );
        return;
      }
      logger.debug(
        `No channels found, retrying in 1s (attempt ${attempt + 1}/${maxAttempts}). ${JSON.stringify({ channels, devices })}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await this.syncEntitiesFromRemote(attempt + 1);
      return;
    }

    logger.log(`Sync entities from remote for ${channels.length} channels`);

    for (const deviceData of devices) {
      const {
        isBattery,
        serialNumber,
        name,
        model,
        isDoorbell,
        uid,
        channel,
        isMultifocal,
      } = deviceData;
      const identifier = uid || name || `channel-${channel}`;
      // const identifier = uid || mac || (ip !== ipAddress ? ip : undefined) || name || randomBytes(4).toString('hex');

      try {
        const nativeId = this.buildNativeId({
          isBattery,
          isMultifocal,
          identifier,
        });

        // Check if device already exists in cameraNativeMap with a different nativeId format
        // (e.g., with chN- prefix). If so, use that nativeId for the mapping.
        let actualNativeId = nativeId;
        const existingDevice = Array.from(this.cameraNativeMap.entries()).find(
          ([id, camera]) => {
            // Check if the camera matches by channel or UID
            const cameraChannel = camera.storageSettings.values.rtspChannel;
            const cameraUid = camera.storageSettings.values.uid;
            return cameraChannel === channel || (uid && cameraUid === uid);
          },
        );

        if (existingDevice) {
          actualNativeId = existingDevice[0];
          logger.debug(
            `[syncEntities] Using existing nativeId for channel ${channel}: ${actualNativeId} (instead of ${nativeId})`,
          );
        }

        const interfaces = [ScryptedInterface.VideoCamera];
        if (isBattery) {
          interfaces.push(ScryptedInterface.Battery);
        }
        const type = isDoorbell
          ? ScryptedDeviceType.Doorbell
          : ScryptedDeviceType.Camera;

        const device: Device = {
          nativeId,
          name,
          providerNativeId: this.nativeId,
          interfaces,
          type,
          info: {
            manufacturer: "Reolink",
            model,
            serialNumber,
          },
        };

        this.channelToNativeIdMap.set(channel, actualNativeId);

        const allNativeIds = sdk.deviceManager
          .getNativeIds()
          .filter((nid) => !!nid && nid !== this.nativeId);

        const matchingNativeId = allNativeIds.find(
          (nid) =>
            nid.includes(uid) ||
            nid.includes(`channel-${channel}`) ||
            // nid.includes(mac) ||
            // nid.includes(ip) ||
            nid.includes(name) ||
            nid === nativeId,
        );
        if (matchingNativeId) {
          logger.debug(
            `[syncEntities] Skipping channel ${channel} (${name}): already registered as nativeId="${matchingNativeId}" (computed="${nativeId}", uid="${uid}")`,
          );
          continue;
        }

        if (this.discoveredDevices.has(nativeId)) {
          logger.debug(
            `[syncEntities] Skipping channel ${channel} (${name}): already in discoveredDevices cache (nativeId="${nativeId}")`,
          );
          continue;
        }

        this.discoveredDevices.set(nativeId, {
          device,
          description: `${name} (Channel ${channel})`,
          rtspChannel: channel,
          deviceData,
        });

        logger.debug(`Discovered channel ${channel}: ${name}`);
      } catch (e: any) {
        logger.debug(
          `Error processing channel ${channel}: ${e?.message || String(e)}`,
        );
      }
    }

    logger.debug(
      `Channel discovery completed. ${JSON.stringify({ devices, channels })}`,
    );
  }

  async discoverDevices(scan?: boolean): Promise<DiscoveredDevice[]> {
    // If a discovery is already in progress, return that promise
    if (this.discoverDevicesPromise) {
      return await this.discoverDevicesPromise;
    }

    // If scan is requested, start a new discovery
    if (scan) {
      this.discoverDevicesPromise = (async () => {
        try {
          await this.syncEntitiesFromRemote();
          return [...this.discoveredDevices.values()].map((d) => ({
            ...d.device,
            description: d.description,
          }));
        } finally {
          this.discoverDevicesPromise = undefined;
        }
      })();
      return await this.discoverDevicesPromise;
    }

    // If no scan requested, return cached devices immediately
    return [...this.discoveredDevices.values()].map((d) => ({
      ...d.device,
      description: d.description,
    }));
  }

  async adoptDevice(adopt: AdoptDevice): Promise<string> {
    const entry = this.discoveredDevices.get(adopt.nativeId);

    if (!entry) throw new Error("device not found");

    await this.onDeviceEvent(
      ScryptedInterface.DeviceDiscovery,
      await this.discoverDevices(),
    );

    const { uid } = entry.deviceData;

    const { ReolinkBaichuanApi } =
      await import("@apocaliss92/nodelink-js");
    const transport = "tcp";
    const baichuanApi = new ReolinkBaichuanApi({
      host: this.storageSettings.values.ipAddress,
      username: this.storageSettings.values.username,
      password: this.storageSettings.values.password,
      transport,
      channel: entry.rtspChannel,
      uid,
    });
    let capabilities: any;
    let objects: any;
    let presets: any;
    try {
      await baichuanApi.login();
      ({ capabilities, objects, presets } =
        await baichuanApi.getDeviceCapabilities(entry.rtspChannel));
    } finally {
      // Ensure the temporary socket used for adoption is not leaked.
      try {
        await baichuanApi.close({ reason: "adoptDevice" });
      } catch {
        // ignore
      }
    }
    const { interfaces, type } = getDeviceInterfaces({
      capabilities,
      logger: this.getBaichuanLogger(),
    });

    const actualDevice: Device = {
      ...entry.device,
      providerNativeId: this.nativeId,
      interfaces,
      type,
    };

    await sdk.deviceManager.onDeviceDiscovered(actualDevice);

    const device = await this.getDevice(adopt.nativeId);
    const logger = this.getBaichuanLogger();
    logger.log("Adopted device", device?.name, JSON.stringify(actualDevice));
    const { username, password, ipAddress } = this.storageSettings.values;

    device.storageSettings.values.rtspChannel = entry.rtspChannel;
    device.classes = objects;
    device.presets = presets;
    device.storageSettings.values.username = username;
    device.storageSettings.values.password = password;
    device.storageSettings.values.rtspChannel = entry.rtspChannel;
    device.storageSettings.values.ipAddress = ipAddress;
    device.storageSettings.values.uid = uid;

    device.cachedCapabilities = capabilities;

    this.discoveredDevices.delete(adopt.nativeId);
    return device?.id;
  }
}
