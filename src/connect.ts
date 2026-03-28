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
};

export function normalizeUid(uid?: string): string | undefined {
  const v = uid?.trim();
  return v ? v : undefined;
}

export async function createBaichuanApi(props: {
  inputs: BaichuanConnectInputs;
  transport: BaichuanTransport;
}): Promise<ReolinkBaichuanApi> {
  const { inputs, transport } = props;
  const { logger } = inputs;
  const { ReolinkBaichuanApi } =
    await import("@apocaliss92/nodelink-js");

  const base: BaichuanClientOptions = {
    host: inputs.host,
    username: inputs.username,
    password: inputs.password,
    logger,
    debugOptions: inputs.debugOptions ?? {},
  };

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
    transport: "udp",
    uid,
    // NOTE: idleDisconnect is NOT set here - the library handles it internally
    // based on the battery status detected during connection/autodetect
    udpDiscoveryMethod: inputs.udpDiscoveryMethod,
  });
  attachErrorHandler(api);
  return api;
}
