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
import { isMixinFirst, withMixinFirst } from "./mixin-order";

export const INTERCOM_PROVIDER_NATIVE_ID = "reolink-native-intercom";

// Bumped to v2 so devices auto-enabled by an earlier version are revisited once
// and, if the intercom mixin is not first in the chain, moved there. See
// maybeEnableMixin for why the position decides whether two-way audio works.
const AUTO_INCLUDE_TOKEN = "v2";

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
    if (!device) return;

    const alreadyInstalled = !!device.mixins?.includes(this.id);

    // Already handled once with this token.
    if (this.hasEnabledMixin[device.id] === AUTO_INCLUDE_TOKEN) return;

    // Installed by a previous version, but possibly in the wrong position —
    // fall through so the ordering below can correct it.
    if (alreadyInstalled && isMixinFirst(device.mixins, this.id)) {
      this.markHandled(device.id);
      return;
    }

    const match = await this.canMixin(device.type, device.interfaces);
    if (!match) return;

    // Cameras from this plugin now implement Intercom themselves, so the mixin
    // would only duplicate the implementation and its settings group. It stays
    // available for cameras from the official @scrypted/reolink plugin, which
    // is the case it exists for, and stays in place on devices where a previous
    // version already enabled it.
    if (device.interfaces?.includes(ScryptedInterface.Intercom)) {
      this.markHandled(device.id);
      return;
    }

    // Only auto-enable for cameras provided by our own plugin
    const camera = this.plugin?.camerasMap?.get(device.id);
    if (!camera) return;

    // Only auto-enable if the camera actually supports intercom.
    // If capabilities aren't loaded yet, skip — we'll be called again
    // when the device descriptor updates after capability detection.
    const caps = camera.cachedCapabilities;
    if (!caps) return;
    if (!caps.hasIntercom) return;

    // Order decides whether two-way audio works at all — see mixin-order.ts.
    // Appending put us after the WebRTC mixin, which then never saw `Intercom`,
    // negotiated `recvonly`, and left the client without a microphone track.
    const mixins = withMixinFirst(device.mixins, this.id);

    this.console.log(
      alreadyInstalled
        ? `Moving intercom mixin to the front for ${device.name} so two-way audio can negotiate a microphone`
        : `Auto-enabling intercom mixin for ${device.name}`,
    );

    const plugins = await this.pluginsComponent;
    await plugins.setMixins(device.id, mixins);

    this.markHandled(device.id);
  }

  /**
   * Record that this device has been dealt with for the current token, so the
   * ordering above runs once and does not fight a user who later reorders their
   * mixins deliberately.
   */
  private markHandled(deviceId: string): void {
    this.hasEnabledMixin[deviceId] = AUTO_INCLUDE_TOKEN;
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
