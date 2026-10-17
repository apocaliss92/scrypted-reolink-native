import type { DeviceCapabilities } from "@apocaliss92/nodelink-js" with { "resolution-mode": "import" };

/**
 * Some NVRs report doorbellVersion=0 even for channels explicitly identified
 * as Doorbell. Use that channel's Support entry as additional positive evidence.
 */
export function normalizeDoorbellCapabilities<T extends {
  capabilities: DeviceCapabilities;
  support?: { items?: { chnID?: number; channelType?: string }[] };
}>(result: T): T {
  const { capabilities, support } = result;
  const channelSupport = support?.items?.find(
    (item) => item.chnID === capabilities.channel,
  );
  if (
    capabilities.isDoorbell ||
    channelSupport?.channelType?.trim().toLowerCase() !== "doorbell"
  ) {
    return result;
  }

  return {
    ...result,
    capabilities: { ...capabilities, isDoorbell: true },
  };
}
