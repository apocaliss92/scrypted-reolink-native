import {
  OnOff,
  ScryptedDeviceBase,
  Setting,
  Settings,
  SettingValue,
} from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import type { ReolinkCamera } from "../camera";

/**
 * Chime: enable/disable the hardwired chime on the doorbell.
 * turnOn() enables the chime; turnOff() disables (mutes) it.
 * Additional parameters (chime type, timing) are configurable via Settings.
 */
export class ReolinkCameraChime
  extends ScryptedDeviceBase
  implements OnOff, Settings
{
  private get logger(): Console {
    return this.camera.getBaichuanLogger();
  }

  storageSettings = new StorageSettings(this, {
    chimeType: {
      title: "Chime Type",
      description:
        'Chime type string reported by the device (e.g. "dingdong", "single", "dual"). Leave empty to use the current device value.',
      type: "string",
      defaultValue: "",
    },
    time: {
      title: "Chime Duration",
      description:
        "Chime timing/duration value (device-specific). Leave 0 to use the current device value.",
      type: "number",
      defaultValue: 0,
    },
  });

  constructor(
    public camera: ReolinkCamera,
    nativeId: string,
  ) {
    super(nativeId);
  }

  async getSettings(): Promise<Setting[]> {
    return this.storageSettings.getSettings();
  }

  async putSetting(key: string, value: SettingValue): Promise<void> {
    await this.storageSettings.putSetting(key, value);
    await this.applySettings();
  }

  private async applySettings(): Promise<void> {
    const channel = this.camera.storageSettings.values.rtspChannel;
    const chimeType = this.storageSettings.values.chimeType || undefined;
    const time = this.storageSettings.values.time || undefined;
    try {
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        await api.setHardwiredChime(
          { enabled: !!this.on, type: chimeType, time },
          channel,
        );
      });
    } catch (e: any) {
      this.logger.error(
        `Chime: applySettings failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  async turnOn(): Promise<void> {
    const channel = this.camera.storageSettings.values.rtspChannel;
    this.logger.log(`Chime: enable (device=${this.nativeId})`);
    this.on = true;
    this.camera.auxDeviceCooldowns.chime = Date.now();
    try {
      const chimeType = this.storageSettings.values.chimeType || undefined;
      const time = this.storageSettings.values.time || undefined;
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        const state = await api.setHardwiredChime(
          { enabled: true, type: chimeType, time },
          channel,
        );
        this.on = state.enabled;
      });
      this.logger.log(`Chime: enable ok (device=${this.nativeId})`);
    } catch (e: any) {
      this.on = false;
      this.logger.error(
        `Chime: enable failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  async turnOff(): Promise<void> {
    const channel = this.camera.storageSettings.values.rtspChannel;
    this.logger.log(`Chime: disable (device=${this.nativeId})`);
    this.on = false;
    this.camera.auxDeviceCooldowns.chime = Date.now();
    try {
      const chimeType = this.storageSettings.values.chimeType || undefined;
      const time = this.storageSettings.values.time || undefined;
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        const state = await api.setHardwiredChime(
          { enabled: false, type: chimeType, time },
          channel,
        );
        this.on = state.enabled;
      });
      this.logger.log(`Chime: disable ok (device=${this.nativeId})`);
    } catch (e: any) {
      this.on = true;
      this.logger.error(
        `Chime: disable failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }
}
