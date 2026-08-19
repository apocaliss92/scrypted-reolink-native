import sdk, {
  MixinProvider,
  ScryptedDevice,
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

const AUTO_INCLUDE_TOKEN = "v1";

export class ReolinkNativeIntercom
  extends ScryptedDeviceBase
  implements MixinProvider, Settings
{
  currentMixinsMap: Record<string, ReolinkNativeIntercomMixin> = {};
  plugin: ReolinkNativePlugin;
  private hasEnabledMixin: Record<string, string> = {};
  private pluginsComponent: Promise<any>;

  constructor(nativeId: string) {
    super(nativeId);

    try {
      this.hasEnabledMixin = JSON.parse(
        this.storage.getItem("hasEnabledMixin") || "{}",
      );
    } catch {
      this.hasEnabledMixin = {};
    }

    this.pluginsComponent = sdk.systemManager.getComponent("plugins");

    // Watch for new device descriptors to auto-enable on newly added devices
    sdk.systemManager.listen((eventSource, eventDetails) => {
      if (
        eventDetails.eventInterface !== ScryptedInterface.ScryptedDevice ||
        eventDetails.property
      )
        return;
      this.maybeEnableMixin(eventSource);
    });

    // Check all existing devices on startup
    process.nextTick(() => {
      for (const id of Object.keys(sdk.systemManager.getSystemState())) {
        const device = sdk.systemManager.getDeviceById(id);
        this.maybeEnableMixin(device);
      }
    });
  }

  private async maybeEnableMixin(device: ScryptedDevice) {
    if (!device || device.mixins?.includes(this.id)) return;

    // Already auto-enabled once with this token
    if (this.hasEnabledMixin[device.id] === AUTO_INCLUDE_TOKEN) return;

    const match = await this.canMixin(device.type, device.interfaces);
    if (!match) return;

    // Only auto-enable for cameras provided by our own plugin
    const camera = this.plugin?.camerasMap?.get(device.id);
    if (!camera) return;

    // Only auto-enable if the camera actually supports intercom.
    // If capabilities aren't loaded yet, skip — we'll be called again
    // when the device descriptor updates after capability detection.
    const caps = camera.cachedCapabilities;
    if (!caps) return;
    if (!caps.hasIntercom) return;

    this.console.log(`Auto-enabling intercom mixin for ${device.name}`);
    const mixins = (device.mixins || []).slice();
    mixins.push(this.id);
    const plugins = await this.pluginsComponent;
    await plugins.setMixins(device.id, mixins);

    this.hasEnabledMixin[device.id] = AUTO_INCLUDE_TOKEN;
    this.storage.setItem(
      "hasEnabledMixin",
      JSON.stringify(this.hasEnabledMixin),
    );
  }

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
