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
 * Autotracking: controls PTZ auto-tracking (smart track)
 * This accessory controls the PTZ auto-tracking feature on compatible cameras.
 */
export class ReolinkCameraAutotracking
  extends ScryptedDeviceBase
  implements OnOff, Settings
{
  private get logger(): Console {
    return this.camera.getBaichuanLogger();
  }

  storageSettings = new StorageSettings(this, {
    smartTrackType: {
      title: "Track Types",
      description: "Types of objects to track",
      type: "string",
      defaultValue: "people",
      choices: [
        "people",
        "vehicle",
        "dog_cat",
        "people,vehicle",
        "people,dog_cat",
        "vehicle,dog_cat",
        "people,vehicle,dog_cat",
      ],
    },
    smartTrackObjectStopDelay: {
      title: "Stop Delay",
      description:
        "Seconds to wait before stopping tracking when object stops moving",
      type: "number",
      defaultValue: 20,
      range: [5, 60],
    },
    smartTrackObjectDisappearDelay: {
      title: "Disappear Delay",
      description:
        "Seconds to wait before stopping tracking when object disappears",
      type: "number",
      defaultValue: 10,
      range: [5, 60],
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

    // Always apply settings to camera when changed
    await this.applySettings();
  }

  private async applySettings(): Promise<void> {
    const channel = this.camera.storageSettings.values.rtspChannel;
    const smartTrackType = this.storageSettings.values.smartTrackType;
    const stopDelay = this.storageSettings.values.smartTrackObjectStopDelay;
    const disappearDelay =
      this.storageSettings.values.smartTrackObjectDisappearDelay;

    this.logger.log(
      `Autotracking applySettings: trackType=${smartTrackType}, stopDelay=${stopDelay}, disappearDelay=${disappearDelay}`,
    );

    try {
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        await api.setAutotrackingSettings(channel, {
          smartTrackType,
          smartTrackObjectStopDelay: stopDelay,
          smartTrackObjectDisappearDelay: disappearDelay,
        });
      });
      this.logger.log(`Autotracking applySettings: success`);
    } catch (e: any) {
      this.logger.error(
        `Autotracking applySettings: failed`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  async turnOff(): Promise<void> {
    this.logger.log(`Autotracking toggle: turnOff (device=${this.nativeId})`);
    this.on = false;
    this.camera.auxDeviceCooldowns.autotracking = Date.now();
    try {
      const channel = this.camera.storageSettings.values.rtspChannel;
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        await api.setAutotracking(false, channel);
      });
      this.logger.log(
        `Autotracking toggle: turnOff ok (device=${this.nativeId})`,
      );
    } catch (e: any) {
      this.on = true; // Revert on failure
      this.logger.error(
        `Autotracking toggle: turnOff failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  async turnOn(): Promise<void> {
    this.logger.log(`Autotracking toggle: turnOn (device=${this.nativeId})`);
    this.on = true;
    this.camera.auxDeviceCooldowns.autotracking = Date.now();
    try {
      const channel = this.camera.storageSettings.values.rtspChannel;
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        await api.setAutotracking(true, channel);
      });
      this.logger.log(
        `Autotracking toggle: turnOn ok (device=${this.nativeId})`,
      );
    } catch (e: any) {
      this.on = false; // Revert on failure
      this.logger.error(
        `Autotracking toggle: turnOn failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }
}
