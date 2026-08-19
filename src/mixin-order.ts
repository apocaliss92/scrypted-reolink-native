/**
 * Where the intercom mixin has to sit in a device's mixin chain.
 *
 * Scrypted builds the chain in array order and hands each mixin only the
 * interfaces contributed by the entries *before* it: in
 * `server/src/plugin/plugin-device.ts`, `rebuildEntry` passes
 * `previousInterfaces` — the accumulated list so far — as the
 * `mixinDeviceInterfaces` argument to `getMixin`.
 *
 * The WebRTC mixin keys the audio transceiver direction off exactly that list
 * (`plugins/webrtc/src/main.ts`):
 *
 *     const hasIntercom = this.mixinDeviceInterfaces.includes(ScryptedInterface.Intercom);
 *     ...
 *     hasIntercom ? 'sendrecv' : 'recvonly',
 *
 * So a device whose intercom mixin is appended after WebRTC negotiates
 * `recvonly`. The client is never asked for a microphone, iOS never shows the
 * orange recording indicator, and nothing reaches the plugin to log — the
 * failure is entirely in the SDP, before any audio exists.
 *
 * Kept free of imports so it can be unit tested without pulling in the Scrypted
 * SDK, whose exports map does not resolve under vitest.
 */

/**
 * Returns the mixin list with `mixinId` first, preserving the relative order of
 * everything else and removing any duplicate of `mixinId`.
 */
export function withMixinFirst(
  mixins: readonly string[] | undefined,
  mixinId: string,
): string[] {
  const rest = (mixins ?? []).filter((id) => id !== mixinId);
  return [mixinId, ...rest];
}

/**
 * True when the chain already has `mixinId` in front, i.e. there is nothing to
 * correct. Used to avoid rewriting a device that is already correct.
 */
export function isMixinFirst(
  mixins: readonly string[] | undefined,
  mixinId: string,
): boolean {
  return (mixins ?? [])[0] === mixinId;
}
