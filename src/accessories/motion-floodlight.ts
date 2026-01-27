import {
  Brightness,
  OnOff,
  ScryptedDeviceBase,
  Setting,
  Settings,
  SettingValue,
} from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import type { ReolinkCamera } from "../camera";

/**
 * Motion-floodlight: controls motion detection light (MD light)
 * This accessory controls the floodlight that turns on when motion is detected.
 */
export class ReolinkCameraMotionFloodlight
  extends ScryptedDeviceBase
  implements OnOff, Brightness, Settings
{
  private get logger(): Console {
    return this.camera.getBaichuanLogger();
  }

  storageSettings = new StorageSettings(this, {
    duration: {
      title: "Light Duration",
      description: "How long the light stays on after motion (in seconds)",
      type: "number",
      defaultValue: 180,
      range: [1, 600],
    },
    detectType: {
      title: "Detection Types",
      description: "Types of objects that trigger the light",
      type: "string",
      defaultValue: "people,vehicle,dog_cat",
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
    const duration = this.storageSettings.values.duration;
    const detectType = this.storageSettings.values.detectType;

    this.logger.log(
      `Motion-floodlight applySettings: duration=${duration}, detectType=${detectType}`,
    );

    try {
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        await api.setFloodlightSettings(channel, { duration, detectType });
      });
      this.logger.log(`Motion-floodlight applySettings: success`);
    } catch (e: any) {
      this.logger.error(
        `Motion-floodlight applySettings: failed`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  async setBrightness(brightness: number): Promise<void> {
    this.logger.log(
      `Motion-floodlight toggle: setBrightness (device=${this.nativeId} brightness=${brightness})`,
    );
    this.brightness = brightness;
    try {
      const channel = this.camera.storageSettings.values.rtspChannel;
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        await api.setWhiteLedState(channel, undefined, brightness);
        // Trust the set operation
      });
      this.logger.log(
        `Motion-floodlight toggle: setBrightness ok (device=${this.nativeId} brightness=${brightness})`,
      );
    } catch (e: any) {
      this.logger.warn(
        `Motion-floodlight toggle: setBrightness failed (device=${this.nativeId} brightness=${brightness})`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  async turnOff(): Promise<void> {
    this.logger.log(
      `Motion-floodlight toggle: turnOff (device=${this.nativeId})`,
    );
    this.on = false;
    this.camera.auxDeviceCooldowns.motionFloodlight = Date.now();
    try {
      const channel = this.camera.storageSettings.values.rtspChannel;
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        // Use setFloodlightOnMotion (cmdId=290 FloodlightTask) for motion-triggered floodlight
        await api.setFloodlightOnMotion(false, channel);
        // Trust the set operation - don't read back immediately as camera may have delay
      });
      this.logger.log(
        `Motion-floodlight toggle: turnOff ok (device=${this.nativeId})`,
      );
    } catch (e: any) {
      this.on = true; // Revert on failure
      this.logger.warn(
        `Motion-floodlight toggle: turnOff failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  async turnOn(): Promise<void> {
    this.logger.log(
      `Motion-floodlight toggle: turnOn (device=${this.nativeId})`,
    );
    this.on = true;
    this.camera.auxDeviceCooldowns.motionFloodlight = Date.now();
    try {
      const channel = this.camera.storageSettings.values.rtspChannel;
      const duration = this.storageSettings.values.duration;
      const detectType = this.storageSettings.values.detectType;
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        // Use setFloodlightOnMotion (cmdId=290 FloodlightTask) for motion-triggered floodlight
        await api.setFloodlightOnMotion(true, channel);
        // Apply settings (duration, detectType)
        await api.setFloodlightSettings(channel, { duration, detectType });
        // Trust the set operation - don't read back immediately as camera may have delay
      });
      this.logger.log(
        `Motion-floodlight toggle: turnOn ok (device=${this.nativeId})`,
      );
    } catch (e: any) {
      this.on = false; // Revert on failure
      this.logger.warn(
        `Motion-floodlight toggle: turnOn failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }
}
