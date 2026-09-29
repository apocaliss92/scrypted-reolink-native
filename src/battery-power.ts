/**
 * Whether the camera reports that it is being powered from a mains adapter or a
 * solar panel, as opposed to running on its battery.
 *
 * `adapterStatus` is the firmware's own string and is not standardised across
 * models: "adapter" or "solarPanel" on the cameras this plugin was first written
 * against, "none" while running on battery, and "ACAdapter" on the Reolink Video
 * Doorbell (seen on firmware v3.0.0.7261_26092204). The value decides the
 * published `ChargeState`, and Scrypted's Rebroadcast plugin only prebuffers a
 * battery camera while it is charging - so a wired doorbell that reads as "not
 * charging" silently falls back to on-demand streams.
 *
 * Anything unrecognised (including a missing value) counts as not powered by an
 * adapter, which keeps the previous behaviour for every value seen before.
 */
export function isAdapterPowered(adapterStatus: string | null | undefined): boolean {
  if (!adapterStatus) return false;
  return /^(adapter|acadapter|solarpanel)$/i.test(adapterStatus.trim());
}
