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
 * PIR Sensor: controls PIR (Passive Infrared) motion detection sensor
 * This accessory controls the PIR sensor on battery-powered cameras.
 */
export class ReolinkCameraPirSensor
  extends ScryptedDeviceBase
  implements OnOff, Settings
{
  private get logger(): Console {
    return this.camera.getBaichuanLogger();
  }

  storageSettings = new StorageSettings(this, {
    sensitive: {
      title: "PIR Sensitivity",
      description: "Detection sensitivity/threshold (higher = more sensitive)",
      type: "number",
      defaultValue: 50,
      range: [0, 100],
    },
    reduceAlarm: {
      title: "Reduce False Alarms",
      description: "Enable reduction of false alarm rate",
      type: "boolean",
      defaultValue: false,
    },
    interval: {
      title: "PIR Detection Interval",
      description: "Detection interval in seconds",
      type: "number",
      defaultValue: 5,
      range: [1, 60],
    },
  });

  constructor(
    public camera: ReolinkCamera,
    nativeId: string,
  ) {
    super(nativeId);
  }

  async getSettings(): Promise<Setting[]> {
    const settings = await this.storageSettings.getSettings();
    return settings;
  }

  async putSetting(key: string, value: SettingValue): Promise<void> {
    await this.storageSettings.putSetting(key, value);

    // Always apply settings to camera when changed
    await this.applySettings();
  }

  private async applySettings(): Promise<void> {
    const channel = this.camera.storageSettings.values.rtspChannel;
    const enabled = this.on ? 1 : 0;
    const sensitive = this.storageSettings.values.sensitive;
    const reduceAlarm = this.storageSettings.values.reduceAlarm ? 1 : 0;
    const interval = this.storageSettings.values.interval;

    this.logger.log(
      `PIR sensor applySettings: sensitive=${sensitive}, reduceAlarm=${reduceAlarm}, interval=${interval}`,
    );

    try {
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        await api.setPirInfo(channel, {
          enable: enabled,
          sensitive: sensitive,
          reduceAlarm: reduceAlarm,
          interval: interval,
        });
      });
      this.logger.log(`PIR sensor applySettings: success`);
    } catch (e: any) {
      this.logger.error(
        `PIR sensor applySettings: failed`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  async turnOff(): Promise<void> {
    this.logger.log(`PIR sensor toggle: turnOff (device=${this.nativeId})`);
    this.on = false;
    this.camera.auxDeviceCooldowns.pir = Date.now();
    await this.updatePirSettings();
  }

  async turnOn(): Promise<void> {
    this.logger.log(`PIR sensor toggle: turnOn (device=${this.nativeId})`);
    this.on = true;
    this.camera.auxDeviceCooldowns.pir = Date.now();
    await this.updatePirSettings();
  }

  private async updatePirSettings(): Promise<void> {
    const channel = this.camera.storageSettings.values.rtspChannel;
    const enabled = this.on ? 1 : 0;
    const sensitive = this.storageSettings.values.sensitive;
    const reduceAlarm = this.storageSettings.values.reduceAlarm ? 1 : 0;
    const interval = this.storageSettings.values.interval;

    try {
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        await api.setPirInfo(channel, {
          enable: enabled,
          sensitive: sensitive,
          reduceAlarm: reduceAlarm,
          interval: interval,
        });
      });
      this.logger.log(
        `PIR sensor toggle: ${enabled ? "turnOn" : "turnOff"} ok (device=${this.nativeId})`,
      );
    } catch (e: any) {
      this.logger.error(
        `PIR sensor toggle: failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }
}
