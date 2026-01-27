import { OnOff, ScryptedDeviceBase } from "@scrypted/sdk";
import type { ReolinkCamera } from "../camera";

/**
 * Siren: direct control (not motion-based)
 * This accessory directly controls the siren on/off state.
 */
export class ReolinkCameraSiren extends ScryptedDeviceBase implements OnOff {
  private get logger(): Console {
    return this.camera.getBaichuanLogger();
  }

  constructor(
    public camera: ReolinkCamera,
    nativeId: string,
  ) {
    super(nativeId);
  }

  async turnOff(): Promise<void> {
    this.logger.log(`Siren toggle: turnOff (device=${this.nativeId})`);
    this.on = false;
    this.camera.auxDeviceCooldowns.siren = Date.now();
    try {
      const channel = this.camera.storageSettings.values.rtspChannel;
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        await api.setSiren(channel, false);
        const sirenState = await api.getSiren(channel);
        this.on = sirenState.enabled;
      });
      this.logger.log(`Siren toggle: turnOff ok (device=${this.nativeId})`);
    } catch (e: any) {
      this.logger.error(
        `Siren toggle: turnOff failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }

  async turnOn(): Promise<void> {
    this.logger.log(`Siren toggle: turnOn (device=${this.nativeId})`);
    this.on = true;
    this.camera.auxDeviceCooldowns.siren = Date.now();
    try {
      const channel = this.camera.storageSettings.values.rtspChannel;
      await this.camera.withBaichuanRetry(async () => {
        const api = await this.camera.ensureClient();
        await api.setSiren(channel, true);
        const sirenState = await api.getSiren(channel);
        this.on = sirenState.enabled;
      });
      this.logger.log(`Siren toggle: turnOn ok (device=${this.nativeId})`);
    } catch (e: any) {
      this.logger.error(
        `Siren toggle: turnOn failed (device=${this.nativeId})`,
        e?.message || String(e),
      );
      throw e;
    }
  }
}
