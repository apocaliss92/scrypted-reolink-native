import type {
  BaichuanTransport as BaichuanTransportParent,
  BaichuanClientOptions,
  ReolinkBaichuanApi,
} from "@apocaliss92/nodelink-js" with { "resolution-mode": "import" };

export type BaichuanTransport = BaichuanTransportParent;

export type BaichuanConnectInputs = {
  host: string;
  username: string;
  password: string;
  uid?: string;
  logger?: Console;
  debugOptions?: BaichuanClientOptions["debugOptions"];
  udpDiscoveryMethod?: BaichuanClientOptions["udpDiscoveryMethod"];
  /**
   * When set, the lib api auto-bridges the global email-push bus into
   * its own `simpleEventListeners`, so SMTP motion lands on the same
   * `onSimpleEvent` stream as native Baichuan push. Bridge survives
   * TCP transient disconnects (it's a pure JS fan-out). For Reolink
   * cameras this should be the camera's plugin-side nativeId — the
   * `EmailPushServerDevice` resolves `cam-<nativeId>@<domain>` against
   * the same string, so the round-trip is symmetric.
   */
  emailPushCameraId?: string;
  /** Channel reported on the synthesised event. Default 0. */
  emailPushChannel?: number;
};

export function normalizeUid(uid?: string): string | undefined {
  const v = uid?.trim();
  return v ? v : undefined;
}

/**
 * Fail loudly, and legibly, when the library barrel hands back something that
 * cannot be constructed.
 *
 * Issue #22 reported `pu is not a constructor` from inside autodetect. `pu` is
 * the minified name the plugin bundle gives `ReolinkBaichuanApi`, so the symbol
 * had resolved to a non-constructor at the call site — but a minified identifier
 * tells the user nothing and tells us almost as little.
 *
 * This does not fix that (it has not been reproduced against any published
 * build, and the construction site in autodetect lives in the library). It does
 * mean the plugin's own construction path reports what it actually got instead
 * of an opaque two-letter name.
 */
export function assertConstructible<T>(
  value: T,
  exportName: string,
  moduleName: string,
): T {
  if (typeof value === "function") return value;

  const describe = () => {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "object") {
      const keys = Object.keys(value as object).slice(0, 10);
      return `${typeof value} with keys [${keys.join(", ")}]`;
    }
    return `${typeof value} (${String(value)})`;
  };

  throw new Error(
    `${moduleName} did not export a constructible '${exportName}': got ${describe()}. ` +
      `This usually means the module resolved to an unexpected shape — please report ` +
      `this along with your Scrypted and Node versions.`,
  );
}

export async function createBaichuanApi(props: {
  inputs: BaichuanConnectInputs;
  transport: BaichuanTransport;
}): Promise<ReolinkBaichuanApi> {
  const { inputs, transport } = props;
  const { logger } = inputs;
  const mod = await import("@apocaliss92/nodelink-js");
  const ReolinkBaichuanApi = assertConstructible(
    mod.ReolinkBaichuanApi,
    "ReolinkBaichuanApi",
    "@apocaliss92/nodelink-js",
  );

  const base: BaichuanClientOptions = {
    host: inputs.host,
    username: inputs.username,
    password: inputs.password,
    logger,
    debugOptions: inputs.debugOptions ?? {},
  };

  // The lib's auto-bridge fields belong on the second positional arg
  // of `new ReolinkBaichuanApi(opts)` alongside `nativeOnly` etc.; we
  // build a small `extras` bag and spread it at construction time
  // below for both tcp + udp paths.
  const extras: {
    emailPushCameraId?: string;
    emailPushChannel?: number;
  } = {};
  if (inputs.emailPushCameraId) {
    extras.emailPushCameraId = inputs.emailPushCameraId;
    if (inputs.emailPushChannel !== undefined) {
      extras.emailPushChannel = inputs.emailPushChannel;
    }
  }

  const attachErrorHandler = (api: ReolinkBaichuanApi) => {
    // Critical: BaichuanClient emits 'error'. If nobody listens, Node treats it as an
    // uncaught exception. Ensure we always have a listener.
    try {
      api.client.on("error", (err: unknown) => {
        if (!logger) return;
        const msg =
          (err as any)?.message || (err as any)?.toString?.() || String(err);
        // Only log if it's not a recoverable error to avoid spam
        if (
          typeof msg === "string" &&
          (msg.includes("Baichuan socket closed") ||
            msg.includes("Baichuan UDP stream closed") ||
            msg.includes("Not running"))
        ) {
          // Silently ignore recoverable socket close errors and "Not running" errors
          // "Not running" is common for UDP/battery cameras when sleeping or during initialization
          return;
        }
        logger.error(
          `[BaichuanClient] error (${transport}) ${inputs.host}: ${msg}`,
        );
      });

      // Handle 'close' event to prevent unhandled rejections from pending promises
      api.client.on("close", () => {
        // Socket closed - pending promises will be rejected, but we've already handled errors above
        // This handler prevents the close event from causing issues
      });
    } catch {
      // ignore
    }
  };

  if (transport === "tcp") {
    const api = new ReolinkBaichuanApi({
      ...base,
      ...extras,
      transport: "tcp",
    });
    attachErrorHandler(api);
    return api;
  }

  const uid = normalizeUid(inputs.uid);
  if (!uid) {
    throw new Error("UID is required for UDP cameras (BCUDP)");
  }

  const api = new ReolinkBaichuanApi({
    ...base,
    ...extras,
    transport: "udp",
    uid,
    // NOTE: idleDisconnect is NOT set here - the library handles it internally
    // based on the battery status detected during connection/autodetect
    udpDiscoveryMethod: inputs.udpDiscoveryMethod,
  });
  attachErrorHandler(api);
  return api;
}
