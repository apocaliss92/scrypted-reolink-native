import {
  OnOff,
  ScryptedDeviceBase,
  Setting,
  Settings,
  SettingValue,
} from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import type { ChimeCfg } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import type { ReolinkCamera } from "../camera";

/**
 * Chime: enable/disable a paired wireless Reolink Chime receiver.
 *
 * Uses SetDingDongCfg (cmd 487) to enable/disable all event types on the chime,
 * matching the approach used by Home Assistant / reolink_aio.
 *
 * turnOn() enables all event types (chime rings on events).
 * turnOff() disables all event types (chime stays silent).
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

  private async getChimeCfg(): Promise<ChimeCfg | undefined> {
    const channel = this.camera.storageSettings.values.rtspChannel;
    const chimeId = this.wirelessChimeId;
    if (chimeId < 0) return undefined;
    const api = await this.camera.ensureClient();
    const configs = await api.getDingDongCfg(channel);
    return configs.find(c => c.id === chimeId);
  }

  /**
   * Determine if the chime is active by checking if any event type is enabled.
   */
  async syncStateFromDevice(): Promise<boolean | undefined> {
    const cfg = await this.getChimeCfg();
    if (!cfg) return undefined;
    const eventTypes = Object.values(cfg.type);
    if (eventTypes.length === 0) return undefined;
    return eventTypes.some(e => e.valid === 1);
  }

  async turnOn(): Promise<void> {
    const channel = this.camera.storageSettings.values.rtspChannel;
    const chimeId = this.wirelessChimeId;
    this.logger.log(`Chime: enable all events (device=${this.nativeId}, chimeId=${chimeId})`);
    this.camera.auxDeviceCooldowns.chime = Date.now();
    try {
      await this.camera.withBaichuanRetry(async () => {
        const cfg = await this.getChimeCfg();
        if (!cfg) throw new Error(`Chime config not found for chimeId=${chimeId}`);
        const api = await this.camera.ensureClient();
        for (const [eventType, alarmCfg] of Object.entries(cfg.type)) {
          if (alarmCfg.valid !== 1) {
            const musicId = alarmCfg.musicId || 1;
            await api.setDingDongCfg(chimeId, eventType, 1, musicId, channel);
          }
        }
      });
      this.on = true;
      this.logger.log(`Chime: enable ok (device=${this.nativeId})`);
    } catch (e: any) {
      this.logger.error(
        `Chime: enable failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  async turnOff(): Promise<void> {
    const channel = this.camera.storageSettings.values.rtspChannel;
    const chimeId = this.wirelessChimeId;
    this.logger.log(`Chime: disable all events (device=${this.nativeId}, chimeId=${chimeId})`);
    this.camera.auxDeviceCooldowns.chime = Date.now();
    try {
      await this.camera.withBaichuanRetry(async () => {
        const cfg = await this.getChimeCfg();
        if (!cfg) throw new Error(`Chime config not found for chimeId=${chimeId}`);
        const api = await this.camera.ensureClient();
        for (const [eventType, alarmCfg] of Object.entries(cfg.type)) {
          if (alarmCfg.valid !== 0) {
            await api.setDingDongCfg(chimeId, eventType, 0, alarmCfg.musicId, channel);
          }
        }
      });
      this.on = false;
      this.logger.log(`Chime: disable ok (device=${this.nativeId})`);
    } catch (e: any) {
      this.logger.error(
        `Chime: disable failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }
}
