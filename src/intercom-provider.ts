import {
  MixinProvider,
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  Setting,
  Settings,
  SettingValue,
  WritableDeviceState,
} from "@scrypted/sdk";
import type ReolinkNativePlugin from "./main";
import { ReolinkNativeIntercomMixin } from "./intercom-mixin";

export const INTERCOM_PROVIDER_NATIVE_ID = "reolink-native-intercom";

export class ReolinkNativeIntercom
  extends ScryptedDeviceBase
  implements MixinProvider, Settings
{
  currentMixinsMap: Record<string, ReolinkNativeIntercomMixin> = {};
  plugin: ReolinkNativePlugin;

  // No auto-enable: cameras from this plugin implement Intercom on the device
  // itself (see getDeviceInterfaces), which is order-independent with respect
  // to the WebRTC mixin. The mixin stays available — and keeps working where a
  // previous version enabled it — mainly for cameras from @scrypted/reolink.

  async canMixin(
    type: ScryptedDeviceType,
    interfaces: string[],
  ): Promise<string[] | null> {
    if (
      (type === ScryptedDeviceType.Camera ||
        type === ScryptedDeviceType.Doorbell) &&
      interfaces.includes(ScryptedInterface.VideoCamera)
    ) {
      return [ScryptedInterface.Intercom, ScryptedInterface.Settings];
    }
    return null;
  }

  async getMixin(
    mixinDevice: any,
    mixinDeviceInterfaces: ScryptedInterface[],
    mixinDeviceState: WritableDeviceState,
  ): Promise<any> {
    return new ReolinkNativeIntercomMixin(
      {
        mixinDevice,
        mixinDeviceInterfaces,
        mixinDeviceState,
        mixinProviderNativeId: this.nativeId,
        group: "Reolink Native Intercom",
        groupKey: "reolinkNativeIntercom",
      },
      this,
    );
  }

  async releaseMixin(id: string, mixinDevice: any): Promise<void> {
    const mixin = this.currentMixinsMap[id];
    if (mixin) {
      await mixin.release();
      delete this.currentMixinsMap[id];
    }
  }

  async getSettings(): Promise<Setting[]> {
    return [];
  }

  async putSetting(key: string, value: SettingValue): Promise<void> {}
}
