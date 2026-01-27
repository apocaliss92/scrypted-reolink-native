import { Brightness, OnOff, ScryptedDeviceBase } from "@scrypted/sdk";
import type { ReolinkCamera } from "../camera";

/**
 * Floodlight: direct control (not motion-based)
 * This accessory directly controls the floodlight on/off state and brightness.
 */
export class ReolinkCameraFloodlight
  extends ScryptedDeviceBase
  implements OnOff, Brightness
{
  private get logger(): Console {
    return this.camera.getBaichuanLogger();
  }

  constructor(
    public camera: ReolinkCamera,
    nativeId: string,
  ) {
    super(nativeId);
  }

  async setBrightness(brightness: number): Promise<void> {
    this.logger.log(
      `Floodlight toggle: setBrightness (device=${this.nativeId} brightness=${brightness})`,
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
        `Floodlight toggle: setBrightness ok (device=${this.nativeId} brightness=${brightness})`,
      );
    } catch (e: any) {
      this.logger.warn(
        `Floodlight toggle: setBrightness failed (device=${this.nativeId} brightness=${brightness})`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  async turnOff(): Promise<void> {
    this.logger.log(`Floodlight toggle: turnOff (device=${this.nativeId})`);
    this.on = false;
    this.camera.auxDeviceCooldowns.floodlight = Date.now();
    try {
      const channel = this.camera.storageSettings.values.rtspChannel;
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        await api.setWhiteLedState(channel, false);
        // Trust the set operation - don't read back immediately as camera may have delay
      });
      this.logger.log(
        `Floodlight toggle: turnOff ok (device=${this.nativeId})`,
      );
    } catch (e: any) {
      this.on = true; // Revert on failure
      this.logger.warn(
        `Floodlight toggle: turnOff failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  async turnOn(): Promise<void> {
    this.logger.log(`Floodlight toggle: turnOn (device=${this.nativeId})`);
    this.on = true;
    this.camera.auxDeviceCooldowns.floodlight = Date.now();
    try {
      const channel = this.camera.storageSettings.values.rtspChannel;
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        await api.setWhiteLedState(channel, true);
        // Trust the set operation - don't read back immediately as camera may have delay
      });
      this.logger.log(`Floodlight toggle: turnOn ok (device=${this.nativeId})`);
    } catch (e: any) {
      this.on = false; // Revert on failure
      this.logger.warn(
        `Floodlight toggle: turnOn failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }
}
