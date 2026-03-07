import {
  OnOff,
  ScryptedDeviceBase,
  Setting,
  Settings,
  SettingValue,
} from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import type { ReolinkCamera } from "../camera";

const DEFAULT_SILENT_DURATION_MINUTES = 30;

/**
 * Chime: enable/disable a paired wireless Reolink Chime receiver.
 *
 * Uses SetDingDongSilent (cmd 610) to silence/unsilence the chime for a
 * configurable duration in minutes.
 *
 * turnOn()  → setDingDongSilent(chimeId, 0) — un-silence the chime.
 * turnOff() → setDingDongSilent(chimeId, seconds) — silence the chime for the configured duration.
 *
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
    silentDurationMinutes: {
      title: "Silent Duration (minutes)",
      description:
        "How long the chime stays silent when turned off, in minutes. " +
        "After this time the chime automatically becomes active again.",
      type: "number",
      defaultValue: DEFAULT_SILENT_DURATION_MINUTES,
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

  get wirelessChimeId(): number {
    return this.storageSettings.values.wirelessChimeId ?? -1;
  }

  /** Silent duration in seconds derived from the user-facing minutes setting. */
  private get silentDurationSeconds(): number {
    const minutes = this.storageSettings.values.silentDurationMinutes ?? DEFAULT_SILENT_DURATION_MINUTES;
    return Math.max(1, Math.round(minutes)) * 60;
  }

  /**
   * Refresh chime ID from device when -1.
   * Python lib: GetDingDongList uses deviceId; GetDingDongCfg uses ringId (skips if < 0).
   * Returns true if we have a valid chimeId; false if still not discovered.
   */
  private async ensureChimeId(): Promise<boolean> {
    if (this.wirelessChimeId >= 0) return true;
    const channel = this.camera.storageSettings.values.rtspChannel;
    const api = await this.camera.ensureClient();
    const list = await api.getDingDongList(channel);
    if (list.length > 0 && list[0].id >= 0) {
      this.storageSettings.values.wirelessChimeId = list[0].id;
      this.logger.log(`Chime: discovered chimeId=${list[0].id} from GetDingDongList`);
      return true;
    }
    const configs = await api.getDingDongCfg(channel);
    const cfg = configs.find(c => c.id >= 0);
    if (cfg) {
      this.storageSettings.values.wirelessChimeId = cfg.id;
      this.logger.log(`Chime: discovered chimeId=${cfg.id} from GetDingDongCfg`);
      return true;
    }
    return false;
  }

  /**
   * Determine if the chime is active by querying the silent-mode state (cmd 609).
   * active === true means the chime is NOT silenced (on).
   */
  async syncStateFromDevice(): Promise<boolean | undefined> {
    await this.ensureChimeId();
    const chimeId = this.wirelessChimeId;
    if (chimeId < 0) return undefined;
    const channel = this.camera.storageSettings.values.rtspChannel;
    const api = await this.camera.ensureClient();
    const state = await api.getDingDongSilent(chimeId, channel);
    return state.active;
  }

  async turnOn(): Promise<void> {
    this.camera.auxDeviceCooldowns.chime = Date.now();
    try {
      await this.camera.withBaichuanRetry(async () => {
        const discovered = await this.ensureChimeId();
        if (!discovered) {
          throw new Error(
            "Wireless chime not discovered. Ensure a Reolink Chime is paired with the doorbell and try again.",
          );
        }
        const channel = this.camera.storageSettings.values.rtspChannel;
        const chimeId = this.wirelessChimeId;
        this.logger.log(`Chime: un-silence (device=${this.nativeId}, chimeId=${chimeId})`);
        const api = await this.camera.ensureClient();
        await api.setDingDongSilent(chimeId, 0, channel);
      });
      this.on = true;
      this.logger.log(`Chime: un-silence ok (device=${this.nativeId})`);
    } catch (e: any) {
      this.logger.error(
        `Chime: un-silence failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  async turnOff(): Promise<void> {
    this.camera.auxDeviceCooldowns.chime = Date.now();
    try {
      await this.camera.withBaichuanRetry(async () => {
        const discovered = await this.ensureChimeId();
        if (!discovered) {
          throw new Error(
            "Wireless chime not discovered. Ensure a Reolink Chime is paired with the doorbell and try again.",
          );
        }
        const channel = this.camera.storageSettings.values.rtspChannel;
        const chimeId = this.wirelessChimeId;
        const seconds = this.silentDurationSeconds;
        this.logger.log(
          `Chime: silence for ${seconds}s (device=${this.nativeId}, chimeId=${chimeId})`,
        );
        const api = await this.camera.ensureClient();
        await api.setDingDongSilent(chimeId, seconds, channel);
      });
      this.on = false;
      this.logger.log(`Chime: silence ok (device=${this.nativeId})`);
    } catch (e: any) {
      this.logger.error(
        `Chime: silence failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }
}
