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
 * Motion-siren: controls motion detection alarm (MD alarm)
 * This accessory triggers the siren when motion is detected based on configured detection types.
 */
export class ReolinkCameraMotionSiren
  extends ScryptedDeviceBase
  implements OnOff, Settings
{
  private get logger(): Console {
    return this.camera.getBaichuanLogger();
  }

  storageSettings = new StorageSettings(this, {
    detectTypes: {
      title: "Detection Types",
      description: "Types of motion events that trigger the siren",
      type: "string",
      defaultValue: "MD,people,vehicle,dog_cat",
      choices: [
        "MD",
        "people",
        "vehicle",
        "dog_cat",
        "MD,people",
        "MD,vehicle",
        "MD,dog_cat",
        "people,vehicle",
        "people,dog_cat",
        "vehicle,dog_cat",
        "MD,people,vehicle",
        "MD,people,dog_cat",
        "MD,vehicle,dog_cat",
        "people,vehicle,dog_cat",
        "MD,people,vehicle,dog_cat",
      ],
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
    // Always apply settings to camera when changed (only if siren is enabled)
    if (this.on) {
      await this.applySettings();
    }
  }

  private async applySettings(): Promise<void> {
    const channel = this.camera.storageSettings.values.rtspChannel;
    const typeScheduleList = this.buildTypeScheduleList();

    this.logger.log(
      `Motion-siren applySettings: detectTypes=${this.storageSettings.values.detectTypes}`,
    );

    try {
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        await api.setSirenOnMotion({ enable: 1, typeScheduleList }, channel);
      });
      this.logger.log(`Motion-siren applySettings: success`);
    } catch (e: any) {
      this.logger.error(
        `Motion-siren applySettings: failed`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  private buildTypeScheduleList(): Array<{
    type: string;
    valueTable: string;
  }> {
    const detectTypes = this.storageSettings.values.detectTypes || "";
    const types = detectTypes.split(",").map((t: string) => t.trim());
    const allOn = "1".repeat(168);
    const allOff = "0".repeat(168);

    // Build schedule list for each type
    return [
      { type: "MD", valueTable: types.includes("MD") ? allOn : allOff },
      { type: "people", valueTable: types.includes("people") ? allOn : allOff },
      {
        type: "vehicle",
        valueTable: types.includes("vehicle") ? allOn : allOff,
      },
      {
        type: "dog_cat",
        valueTable: types.includes("dog_cat") ? allOn : allOff,
      },
    ];
  }

  async turnOff(): Promise<void> {
    this.logger.log(`Motion-siren toggle: turnOff (device=${this.nativeId})`);
    this.on = false;
    this.camera.auxDeviceCooldowns.motionSiren = Date.now();
    try {
      const channel = this.camera.storageSettings.values.rtspChannel;
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        // Use setSirenOnMotion (cmdId=231 AudioTask) for motion-triggered siren
        await api.setSirenOnMotion({ enable: 0 }, channel);
        // Trust the set operation - don't read back immediately as camera may have delay
      });
      this.logger.log(
        `Motion-siren toggle: turnOff ok (device=${this.nativeId})`,
      );
    } catch (e: any) {
      this.on = true; // Revert on failure
      this.logger.error(
        `Motion-siren toggle: turnOff failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  async turnOn(): Promise<void> {
    this.logger.log(`Motion-siren toggle: turnOn (device=${this.nativeId})`);
    this.on = true;
    this.camera.auxDeviceCooldowns.motionSiren = Date.now();
    try {
      const channel = this.camera.storageSettings.values.rtspChannel;
      const typeScheduleList = this.buildTypeScheduleList();
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        // Use setSirenOnMotion (cmdId=231 AudioTask) for motion-triggered siren
        await api.setSirenOnMotion({ enable: 1, typeScheduleList }, channel);
        // Trust the set operation - don't read back immediately as camera may have delay
      });
      this.logger.log(
        `Motion-siren toggle: turnOn ok (device=${this.nativeId})`,
      );
    } catch (e: any) {
      this.on = false; // Revert on failure
      this.logger.error(
        `Motion-siren toggle: turnOn failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }
}
