import type { ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js" with {
  "resolution-mode": "import",
};
import sdk, {
  Intercom,
  MediaObject,
  Setting,
  Settings,
  SettingValue,
} from "@scrypted/sdk";
import {
  SettingsMixinDeviceBase,
  SettingsMixinDeviceOptions,
} from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import type { BaichuanTransport } from "./connect";
import type { ReolinkNativeIntercom } from "./intercom-provider";
import { ReolinkBaichuanIntercom, type IntercomHost } from "./intercom";
import type { ReolinkCamera } from "./camera";

export class ReolinkNativeIntercomMixin
  extends SettingsMixinDeviceBase<any>
  implements Intercom, Settings
{
  private intercomEngine?: ReolinkBaichuanIntercom;

  storageSettings = new StorageSettings(this, {
    intercomBlocksPerPayload: {
      group: "Intercom",
      title: "Blocks Per Payload",
      description:
        "Lower reduces latency (more packets). Typical: 1-4. Requires restarting talk session to take effect.",
      type: "number",
      defaultValue: 1,
    },
    intercomMaxBacklogMs: {
      group: "Intercom",
      title: "Max Backlog (ms)",
      description:
        "Maximum PCM backlog before dropping old audio to cap latency. Higher improves stability on slow systems but increases latency. Typical: 80-250. Requires restarting talk session to take effect.",
      type: "number",
      defaultValue: 120,
    },
    intercomGain: {
      group: "Intercom",
      title: "Gain",
      description:
        "Output gain multiplier applied before encoding. 1.0 = normal, 2.0 ≈ +6dB, 0.5 ≈ -6dB. Requires restarting talk session to take effect.",
      type: "number",
      defaultValue: 1.0,
    },
  });

  constructor(
    options: SettingsMixinDeviceOptions<any>,
    public provider: ReolinkNativeIntercom,
  ) {
    super(options);
    this.provider.currentMixinsMap[this.id] = this;
  }

  private getInternalCamera(): ReolinkCamera | undefined {
    return this.provider.plugin?.camerasMap?.get(this.id);
  }

  private async getReolinkPluginCredentials(): Promise<
    { host?: string; username?: string; password?: string } | undefined
  > {
    try {
      const device = sdk.systemManager.getDeviceById(this.id);
      if (device?.pluginId !== "@scrypted/reolink") return undefined;

      const settings: Setting[] = await this.mixinDevice.getSettings();
      const map = new Map(
        settings.map((s: Setting) => [s.key, s.value?.toString()]),
      );

      // Non-NVR cameras use "ip", NVR child cameras use "ipAddress"
      const host = map.get("ip") || map.get("ipAddress");
      const username = map.get("username");
      const password = map.get("password");

      return { host, username, password };
    } catch {
      return undefined;
    }
  }

  private buildHost(): IntercomHost {
    const self = this;
    const internalCamera = this.getInternalCamera();

    if (internalCamera) {
      return {
        get blocksPerPayload() {
          return Math.max(
            1,
            Math.min(
              8,
              self.storageSettings.values.intercomBlocksPerPayload ?? 1,
            ),
          );
        },
        get outputGain() {
          const v = Number(self.storageSettings.values.intercomGain);
          return Number.isFinite(v) ? Math.max(0.1, Math.min(10, v)) : 1.0;
        },
        get maxBacklogMs() {
          const v = Number(self.storageSettings.values.intercomMaxBacklogMs);
          return Number.isFinite(v) ? Math.max(20, Math.min(5000, v)) : 120;
        },
        get channel() {
          return internalCamera.storageSettings.values.rtspChannel;
        },
        get isBatteryCamera() {
          return internalCamera.isBattery;
        },
        get deviceId() {
          return internalCamera.nativeId;
        },
        get logger() {
          return internalCamera.getBaichuanLogger();
        },
        ensureApi: () => internalCamera.ensureBaichuanClient(),
        withRetry: (fn) => internalCamera.withBaichuanRetry(fn),
      };
    }

    // External path (@scrypted/reolink): use shared client from plugin registry
    return {
      get blocksPerPayload() {
        return Math.max(
          1,
          Math.min(
            8,
            self.storageSettings.values.intercomBlocksPerPayload ?? 1,
          ),
        );
      },
      get outputGain() {
        const v = Number(self.storageSettings.values.intercomGain);
        return Number.isFinite(v) ? Math.max(0.1, Math.min(10, v)) : 1.0;
      },
      get maxBacklogMs() {
        const v = Number(self.storageSettings.values.intercomMaxBacklogMs);
        return Number.isFinite(v) ? Math.max(20, Math.min(5000, v)) : 120;
      },
      get channel() {
        return 0;
      },
      get isBatteryCamera() {
        return false;
      },
      get deviceId() {
        return self.id;
      },
      get logger() {
        return self.console;
      },
      ensureApi: () => self.ensureExternalApi(),
      withRetry: (fn) => fn(),
    };
  }

  private async ensureExternalApi(): Promise<ReolinkBaichuanApi> {
    const creds = await this.getReolinkPluginCredentials();

    if (!creds?.host || !creds?.username || !creds?.password) {
      throw new Error(
        "Could not read camera credentials from @scrypted/reolink settings",
      );
    }

    const transport: BaichuanTransport = "tcp";

    return await this.provider.plugin.acquireExternalClient(this.id, {
      host: creds.host,
      username: creds.username,
      password: creds.password,
      transport,
      logger: this.console,
    });
  }

  async startIntercom(media: MediaObject): Promise<void> {
    const host = this.buildHost();
    this.intercomEngine = new ReolinkBaichuanIntercom(host);
    await this.intercomEngine.start(media);
  }

  async stopIntercom(): Promise<void> {
    if (this.intercomEngine) {
      await this.intercomEngine.stop();
      this.intercomEngine = undefined;
    }
  }

  async getMixinSettings(): Promise<Setting[]> {
    return this.storageSettings.getSettings();
  }

  async putMixinSetting(
    key: string,
    value: SettingValue,
  ): Promise<void> {
    await this.storageSettings.putSetting(key, value);
  }

  async release(): Promise<void> {
    if (this.intercomEngine) {
      await this.intercomEngine.stop();
      this.intercomEngine = undefined;
    }
    // Release external client if not internal
    if (!this.getInternalCamera()) {
      await this.provider.plugin?.releaseExternalClient(this.id);
    }
    delete this.provider.currentMixinsMap[this.id];
  }
}
