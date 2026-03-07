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
 * Chime: mute/unmute a paired wireless Reolink Chime receiver.
 * turnOn() unmutes (time=0); turnOff() silences for muteDurationSec seconds.
 * The chime ID is auto-synced from getDingDongList during alignAuxDevicesState.
 */
export class ReolinkCameraChime
  extends ScryptedDeviceBase
  implements OnOff, Settings
{
  private get logger(): Console {
    return this.camera.getBaichuanLogger();
  }

  storageSettings = new StorageSettings(this, {
    wirelessChimeId: {
      title: "Wireless Chime ID",
      description: "ID of the paired wireless Reolink Chime (auto-detected from device).",
      type: "number",
      defaultValue: -1,
      readonly: true,
    },
    muteDurationSec: {
      title: "Mute Duration (seconds)",
      description:
        "How long to mute the wireless chime when turned off (default: 3600 = 1 hour).",
      type: "number",
      defaultValue: 3600,
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
  }

  private get wirelessChimeId(): number {
    return this.storageSettings.values.wirelessChimeId ?? -1;
  }

  async turnOn(): Promise<void> {
    const channel = this.camera.storageSettings.values.rtspChannel;
    const chimeId = this.wirelessChimeId;
    this.logger.log(`Chime: unmute (device=${this.nativeId}, chimeId=${chimeId})`);
    this.camera.auxDeviceCooldowns.chime = Date.now();
    try {
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        await api.setDingDongSilent(chimeId, 0, channel);
      });
      this.on = true;
      this.logger.log(`Chime: unmute ok (device=${this.nativeId})`);
    } catch (e: any) {
      this.logger.error(
        `Chime: unmute failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  async turnOff(): Promise<void> {
    const channel = this.camera.storageSettings.values.rtspChannel;
    const chimeId = this.wirelessChimeId;
    const muteSec = this.storageSettings.values.muteDurationSec ?? 3600;
    this.logger.log(`Chime: mute for ${muteSec}s (device=${this.nativeId}, chimeId=${chimeId})`);
    this.camera.auxDeviceCooldowns.chime = Date.now();
    try {
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        await api.setDingDongSilent(chimeId, muteSec, channel);
      });
      this.on = false;
      this.logger.log(`Chime: mute ok (device=${this.nativeId})`);
    } catch (e: any) {
      this.logger.error(
        `Chime: mute failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }
}
