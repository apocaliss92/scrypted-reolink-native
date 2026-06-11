import type {
  BaichuanClientOptions,
  ReolinkBaichuanApi,
  ReolinkSimpleEvent,
} from "@apocaliss92/nodelink-js" with { "resolution-mode": "import" };
import { ScryptedDeviceBase } from "@scrypted/sdk";
import { createBaichuanApi, type BaichuanTransport } from "./connect";
import { StreamManager } from "./stream-utils";

export interface BaichuanConnectionConfig {
  host: string;
  username: string;
  password: string;
  uid?: string;
  transport: BaichuanTransport;
  debugOptions?: any;
  udpDiscoveryMethod?: BaichuanClientOptions["udpDiscoveryMethod"];
  /**
   * When set, the api auto-bridges the global email-push bus into
   * its own `simpleEventListeners` so SMTP motion lands on the same
   * `onSimpleEvent` stream as native Baichuan push. Standalone
   * (non-NVR-child, non-multifocal-lens) cameras only.
   */
  emailPushCameraId?: string;
}

export interface BaichuanConnectionCallbacks {
  onError?: (err: unknown) => void;
  onClose?: () => void | Promise<void>;
  onSimpleEvent?: (ev: ReolinkSimpleEvent) => void;
  getEventSubscriptionEnabled?: () => boolean;
}

/**
 * Logger wrapper that adds device name, timestamp, and debug control
 * Implements Console interface to be compatible with Baichuan API
 */
export class BaichuanLogger implements Console {
  private baseLogger: Console;
  private deviceName: string;
  private isDebugEnabledCallback: () => boolean;

  constructor(
    baseLogger: Console,
    deviceName: string,
    isDebugEnabledCallback: () => boolean,
  ) {
    this.baseLogger = baseLogger;
    this.deviceName = deviceName;
    this.isDebugEnabledCallback = isDebugEnabledCallback;
  }

  private formatMessage(level: string, ...args: any[]): string {
    const timestamp = new Date().toLocaleString();
    const prefix = `[${this.deviceName}] [${timestamp}] [${level}]`;
    return `${prefix} ${args.map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg))).join(" ")}`;
  }

  log(...args: any[]): void {
    this.baseLogger.log(this.formatMessage("LOG", ...args));
  }

  error(...args: any[]): void {
    this.baseLogger.error(this.formatMessage("ERROR", ...args));
  }

  warn(...args: any[]): void {
    this.baseLogger.warn(this.formatMessage("WARN", ...args));
  }

  debug(...args: any[]): void {
    if (this.isDebugEnabledCallback()) {
      this.baseLogger.debug(this.formatMessage("DEBUG", ...args));
    }
  }

  // Console interface implementation - delegate to baseLogger
  assert(condition?: boolean, ...data: any[]): void {
    this.baseLogger.assert(condition, ...data);
  }

  clear(): void {
    this.baseLogger.clear();
  }

  count(label?: string): void {
    this.baseLogger.count(label);
  }

  countReset(label?: string): void {
    this.baseLogger.countReset(label);
  }

  dir(item?: any, options?: any): void {
    this.baseLogger.dir(item, options);
  }

  dirxml(...data: any[]): void {
    this.baseLogger.dirxml(...data);
  }

  group(...data: any[]): void {
    this.baseLogger.group(...data);
  }

  groupCollapsed(...data: any[]): void {
    this.baseLogger.groupCollapsed(...data);
  }

  groupEnd(): void {
    this.baseLogger.groupEnd();
  }

  info(...data: any[]): void {
    this.baseLogger.info(this.formatMessage("INFO", ...data));
  }

  table(tabularData?: any, properties?: string[]): void {
    this.baseLogger.table(tabularData, properties);
  }

  time(label?: string): void {
    this.baseLogger.time(label);
  }

  timeEnd(label?: string): void {
    this.baseLogger.timeEnd(label);
  }

  timeLog(label?: string, ...data: any[]): void {
    this.baseLogger.timeLog(label, ...data);
  }

  trace(...data: any[]): void {
    this.baseLogger.trace(...data);
  }

  // Console properties
  get memory(): any {
    return (this.baseLogger as any).memory;
  }

  get Console(): any {
    return (this.baseLogger as any).Console;
  }

  // Node.js specific
  profile(label?: string): void {
    if (typeof (this.baseLogger as any).profile === "function") {
      (this.baseLogger as any).profile(label);
    }
  }

  profileEnd(label?: string): void {
    if (typeof (this.baseLogger as any).profileEnd === "function") {
      (this.baseLogger as any).profileEnd(label);
    }
  }

  timeStamp(label?: string): void {
    if (typeof (this.baseLogger as any).timeStamp === "function") {
      (this.baseLogger as any).timeStamp(label);
    }
  }

  context(...data: any[]): void {
    if (typeof (this.baseLogger as any).context === "function") {
      (this.baseLogger as any).context(...data);
    }
  }
}

/**
 * Base class for managing Baichuan API connections with automatic reconnection,
 * listener management, and event subscription handling.
 */
export abstract class BaseBaichuanClass extends ScryptedDeviceBase {
  protected baichuanApi: ReolinkBaichuanApi | undefined;
  protected ensureClientPromise: Promise<ReolinkBaichuanApi> | undefined;
  protected connectionTime: number | undefined;
  transport: BaichuanTransport;

  constructor(nativeId: string, transport: BaichuanTransport) {
    super(nativeId);
    this.transport = transport;
  }

  private errorListener?: (err: unknown) => void;
  private closeListener?: () => void;
  private lastDisconnectTime: number = 0;
  private cleanupInProgress: boolean = false;
  private readonly reconnectBackoffMs: number = 2000; // 2 seconds minimum between reconnects
  private eventSubscriptionActive: boolean = false;
  private lastEventTime: number = 0;
  // Timestamp of the last triggered (silence-based) event restart. Used to
  // rate-limit full unsub/resub cycles so a persistently-quiet camera can't be
  // restarted on every check window.
  private lastEventRestartTime: number = 0;
  private currentWrappedEventHandler?: (ev: ReolinkSimpleEvent) => void;
  private subscribeToEventsPromise?: Promise<void>;
  private pingInterval?: NodeJS.Timeout;
  private autoRenewInterval?: NodeJS.Timeout;
  private eventCheckInterval?: NodeJS.Timeout;
  private consecutivePingFailures: number = 0;

  /**
   * Get the connection configuration for this instance
   */
  protected abstract getConnectionConfig(): BaichuanConnectionConfig;

  /**
   * Get callbacks for connection events
   */
  protected abstract getConnectionCallbacks(): BaichuanConnectionCallbacks;

  /**
   * Check if this is an NVR/Hub device (multiple channels).
   * Override in subclasses to return true for NVR devices.
   * This is used for socket pooling to allocate separate sockets per channel.
   */
  protected isNvrDevice(): boolean {
    return false; // Default: standalone camera
  }

  /**
   * Check if this is a battery-powered device.
   * Override in subclasses to return true for battery cameras.
   * This is used to enable idle disconnect to preserve battery life.
   */
  protected isBatteryDevice(): boolean {
    return false; // Default: AC-powered
  }

  /**
   * Check if this is a multi-focal/dual-lens device.
   * Override in subclasses to return true for multi-focal cameras.
   * Multi-focal cameras need all channels to share a single streaming socket
   * because they reject concurrent streaming TCP connections (response_code 430).
   */
  protected isMultiFocalDevice(): boolean {
    return false; // Default: single-lens camera
  }

  /**
   * Check if debug logging is enabled
   */
  protected abstract isDebugEnabled(): boolean;

  /**
   * Get the device name for logging
   */
  protected abstract getDeviceName(): string;

  /**
   * Get StreamManager if available (optional, only for devices that support streaming)
   * Override in subclasses that have a StreamManager
   */
  protected getStreamManager?(): StreamManager | undefined;

  /**
   * Get a Baichuan logger instance with formatting and debug control
   * This logger implements Console interface and can be used everywhere
   */
  public getBaichuanLogger(): BaichuanLogger {
    return new BaichuanLogger(this.console, this.getDeviceName(), () =>
      this.isDebugEnabled(),
    );
  }

  /**
   * Cleanup any additional resources (called before closing connection)
   */
  protected async onBeforeCleanup(): Promise<void> {
    // Override in subclasses if needed
  }

  /**
   * Create + login a Baichuan api. For UDP transport, the chain is:
   *   1. `local-direct` (LAN unicast + broadcast — fastest, no internet)
   *      with a tight timeout so it doesn't block the chain if blocked.
   *   2. The configured/saved `udpDiscoveryMethod`.
   *   3. Parallel race of all remaining BCUDP methods.
   * The persisted `udpDiscoveryMethod` is left untouched — the autodetect
   * choice is preserved across reconnects, the fallback only changes
   * behavior for this single attempt.
   *
   * Why: after the initial autodetect picks (say) `remote` because the
   * camera was reachable via Reolink's P2P servers, a later network
   * change can break that path forever — e.g. the camera's VLAN gets
   * blocked from internet, or inter-VLAN broadcast stops working.
   * Without a fallback the camera stays unreachable until manual
   * settings change. And privileging `local-direct` up front handles
   * the LAN-restored case without paying the full saved-method timeout.
   */
  private async createApiWithUdpFallback(
    config: BaichuanConnectionConfig,
    logger: BaichuanLogger,
  ): Promise<ReolinkBaichuanApi> {
    const buildInputs = (
      methodOverride?: BaichuanClientOptions["udpDiscoveryMethod"],
    ) => ({
      host: config.host,
      username: config.username,
      password: config.password,
      uid: config.uid,
      logger,
      debugOptions: config.debugOptions,
      udpDiscoveryMethod:
        methodOverride !== undefined
          ? methodOverride
          : config.udpDiscoveryMethod,
      ...(config.emailPushCameraId
        ? { emailPushCameraId: config.emailPushCameraId }
        : {}),
    });

    // The lib's internal default when `udpDiscoveryMethod` is unset is
    // "local-direct" (see BcUdpStream).
    const configured: NonNullable<
      BaichuanClientOptions["udpDiscoveryMethod"]
    > = config.udpDiscoveryMethod ?? "local-direct";

    // Step 1 (UDP only, skip when configured is already local-direct):
    // preliminary local-direct attempt with a tight 8s timeout. If LAN
    // works, this short-circuits the whole chain in 1-2s. If not, we
    // pay 8s and move on. The lib's internal discovery timeout is 30s,
    // so wrapping with a shorter Promise.race avoids dragging out the
    // common "LAN blocked, use saved method" path.
    if (config.transport === "udp" && configured !== "local-direct") {
      const PRELIM_TIMEOUT_MS = 8000;
      let prelimApi: ReolinkBaichuanApi | undefined;
      try {
        prelimApi = await createBaichuanApi({
          inputs: buildInputs("local-direct"),
          transport: "udp",
        });
        const loginPromise = prelimApi.login();
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  `local-direct prelim exceeded ${PRELIM_TIMEOUT_MS}ms`,
                ),
              ),
            PRELIM_TIMEOUT_MS,
          );
        });
        await Promise.race([loginPromise, timeoutPromise]);
        logger.log(
          `UDP local-direct (preliminary, before saved=${configured}) succeeded`,
        );
        return prelimApi;
      } catch (prelimErr) {
        const prelimMsg =
          prelimErr instanceof Error ? prelimErr.message : String(prelimErr);
        logger.debug(
          `UDP local-direct preliminary failed (${prelimMsg}); falling through to saved=${configured}`,
        );
        if (prelimApi) {
          prelimApi.close({ reason: "udp_prelim_failed" }).catch(() => {
            // ignore
          });
        }
      }
    }

    // Step 2: configured method (or non-UDP transport).
    try {
      const api = await createBaichuanApi({
        inputs: buildInputs(),
        transport: config.transport,
      });
      await api.login();
      return api;
    } catch (primaryErr) {
      if (config.transport !== "udp") throw primaryErr;

      const primaryMsg =
        primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      logger.warn(
        `UDP connect with discoveryMethod=${configured} failed: ${primaryMsg}; racing remaining methods (saved setting preserved)`,
      );

      // Step 3: race the methods we haven't tried yet. local-direct is
      // always excluded (it was either the configured method or the
      // preliminary attempt above), so the race covers at most 4 methods.
      const allMethods: NonNullable<
        BaichuanClientOptions["udpDiscoveryMethod"]
      >[] = ["local-direct", "local-broadcast", "remote", "map", "relay"];
      const remaining = allMethods.filter(
        (m) => m !== configured && m !== "local-direct",
      );
      const created: ReolinkBaichuanApi[] = [];

      try {
        const winner = await Promise.any(
          remaining.map(async (m) => {
            const api = await createBaichuanApi({
              inputs: buildInputs(m),
              transport: "udp",
            });
            created.push(api);
            try {
              await api.login();
              return { method: m, api };
            } catch (e) {
              try {
                await api.close({ reason: `udp_fallback_failed:${m}` });
              } catch {
                // ignore
              }
              throw e;
            }
          }),
        );

        logger.log(
          `UDP fallback succeeded with discoveryMethod=${winner.method} (saved method=${configured} preserved)`,
        );

        // Close the race losers. Some may still be mid-login; api.close()
        // is idempotent and safe to call concurrently with login().
        for (const a of created) {
          if (a !== winner.api) {
            a.close({ reason: "udp_fallback_loser" }).catch(() => {
              // ignore
            });
          }
        }

        return winner.api;
      } catch {
        // All fallback methods also failed. Surface the original error —
        // it's almost always more informative than the AggregateError
        // from Promise.any and matches the pre-fallback behavior callers
        // expect.
        logger.error(
          `UDP fallback exhausted (${remaining.length} methods tried)`,
        );
        throw primaryErr;
      }
    }
  }

  /**
   * Ensure Baichuan client is connected and ready
   */
  async ensureBaichuanClient(): Promise<ReolinkBaichuanApi> {
    const logger = this.getBaichuanLogger();
    const caller = new Error().stack?.split("\n")[2]?.trim() ?? "unknown";

    // Prevent concurrent login storms - check promise first
    if (this.ensureClientPromise) {
      logger.debug(
        `ensureBaichuanClient: waiting on existing promise (caller: ${caller})`,
      );
      return await this.ensureClientPromise;
    }

    // Reuse existing API if possible
    if (this.baichuanApi) {
      // Already connected and ready → reuse immediately
      if (this.baichuanApi.isReady) {
        logger.debug(
          `ensureBaichuanClient: reusing existing client (caller: ${caller})`,
        );
        return this.baichuanApi;
      }

      // API was explicitly closed → destroy and recreate from scratch
      if (this.baichuanApi.isClosed) {
        logger.log(
          `API is closed, creating new instance (caller: ${caller})`,
        );
        await this.cleanupBaichuanApi();
      } else {
        // Socket disconnected but API still valid → let the library reconnect
        // the general socket internally (preserves NVR/multifocal flags,
        // streaming sockets, and all library-side state)
        try {
          logger.log(
            `General socket lost, reconnecting via ensureConnected (caller: ${caller})`,
          );
          await this.baichuanApi.ensureConnected();
          return this.baichuanApi;
        } catch (e) {
          logger.log(
            `ensureConnected failed: ${e instanceof Error ? e.message : String(e)}, creating new instance`,
          );
          await this.cleanupBaichuanApi();
        }
      }
    }

    logger.log(`ensureBaichuanClient: creating NEW client (caller: ${caller})`);

    // IMPORTANT: Assign the promise BEFORE the backoff to prevent parallel reconnections
    this.ensureClientPromise = (async () => {
      // Apply backoff to avoid aggressive reconnection after disconnection
      // This is now INSIDE the promise so concurrent callers will wait on the same promise
      if (this.lastDisconnectTime > 0) {
        const timeSinceDisconnect = Date.now() - this.lastDisconnectTime;
        if (timeSinceDisconnect < this.reconnectBackoffMs) {
          const waitTime = this.reconnectBackoffMs - timeSinceDisconnect;
          const logger = this.getBaichuanLogger();
          logger.log(`Waiting ${waitTime}ms before reconnection (backoff)`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }

      const config = this.getConnectionConfig();

      // Clean up old client if exists
      if (this.baichuanApi) {
        await this.cleanupBaichuanApi();
      }

      // Create new Baichuan client. For UDP transports a fallback chain
      // (preliminary local-direct → saved method → race) is applied
      // inside the helper so the cam recovers from post-autodetect
      // network changes without losing the persisted setting.
      const logger = this.getBaichuanLogger();
      try {
        const api = await this.createApiWithUdpFallback(config, logger);

        // Set NVR flag BEFORE any streaming to ensure correct socket pooling
        // NVR devices need separate sockets per channel
        api.setIsNvr(this.isNvrDevice());

        // Set multi-focal flag BEFORE any streaming to ensure correct socket pooling
        // Multi-focal cameras need all channels on the same streaming socket
        api.setIsMultiFocal(this.isMultiFocalDevice());

        // Enable idle disconnect for battery cameras to preserve battery life
        // AC-powered cameras (including UDP cameras like Elite Floodlight WiFi) don't need it
        if (this.isBatteryDevice()) {
          api.setIdleDisconnect(true);
        }

        // Verify socket is connected before returning
        if (!api.client.isSocketConnected()) {
          throw new Error("Socket not connected after login");
        }

        // Attach listeners
        this.attachBaichuanListeners(api);

        this.baichuanApi = api;
        this.connectionTime = Date.now();

        // Start ping and auto-renewal for TCP connections
        if (this.transport === "tcp") {
          // this.startConnectionMaintenance(api);
        }

        // Start event check for all connections
        this.startEventCheck(api);

        return api;
      } catch (e) {
        // Apply backoff for connection failures too, otherwise multiple callers can hammer connect().
        this.lastDisconnectTime = Date.now();
        // Ensure state is reset so next attempt is clean.
        await this.cleanupBaichuanApi();
        throw e;
      }
    })();

    try {
      return await this.ensureClientPromise;
    } finally {
      // Allow future reconnects and avoid pinning rejected promises
      this.ensureClientPromise = undefined;
    }
  }

  /**
   * Attach error and close listeners to Baichuan API
   */
  private attachBaichuanListeners(api: ReolinkBaichuanApi): void {
    const logger = this.getBaichuanLogger();
    const callbacks = this.getConnectionCallbacks();

    // Error listener
    this.errorListener = (err: unknown) => {
      const msg =
        (err as any)?.message || (err as any)?.toString?.() || String(err);

      // Only log if it's not a recoverable error to avoid spam
      if (
        typeof msg === "string" &&
        (msg.includes("Baichuan socket closed") ||
          msg.includes("Baichuan UDP stream closed") ||
          msg.includes("Not running"))
      ) {
        logger.debug(`error (recoverable): ${msg}`);
        return;
      }
      logger.error(`error: ${msg}`);

      // Call custom error handler if provided
      if (callbacks.onError) {
        try {
          callbacks.onError(err);
        } catch {
          // ignore
        }
      }
    };

    // Close listener
    this.closeListener = async () => {
      // Prevent multiple concurrent cleanup operations
      if (!this.baichuanApi || this.baichuanApi !== api || this.cleanupInProgress) {
        // This close event is for a different/old client or cleanup is already running
        logger.debug("Close event for stale client or cleanup already in progress, ignoring");
        return;
      }

      try {
        const wasConnected = api.client.isSocketConnected();
        const wasLoggedIn = api.client.loggedIn;
        logger.log(
          `Connection state before close: connected=${wasConnected}, loggedIn=${wasLoggedIn}`,
        );

        // Try to get last message info if available
        const client = api.client as any;
        if (client?.lastRx || client?.lastTx) {
          logger.debug(
            `Last message info: lastRx=${JSON.stringify(client.lastRx)}, lastTx=${JSON.stringify(client.lastTx)}`,
          );
        }
      } catch (e) {
        logger.debug(
          `Could not get connection state: ${e?.message || String(e)}`,
        );
      }

      const now = Date.now();
      const timeSinceLastDisconnect = this.lastDisconnectTime > 0
        ? now - this.lastDisconnectTime
        : undefined;
      this.lastDisconnectTime = now;

      logger.log(
        `Socket closed${timeSinceLastDisconnect != null ? ` (last disconnect ${timeSinceLastDisconnect}ms ago)` : " (first disconnect)"} — api object kept alive, will reconnect on next use`,
      );

      // The api object itself stays alive across socket disconnects:
      // - It's NOT explicitly closed (no `_closed = true`), so simple
      //   event listeners, the email-push auto-bridge (when used),
      //   recordings cache, sleep inference state, etc. are preserved
      //   for the next reconnect cycle.
      // - The next `ensureBaichuanClient` call sees `api.isReady=false`
      //   AND `api.isClosed=false` and routes through
      //   `api.ensureConnected()`, which reuses the same api with a
      //   freshly reconnected socket pool — see the
      //   `socket disconnected but API still valid` branch above.
      // - If the lib reconnect fails repeatedly, the same caller
      //   falls back to `cleanupBaichuanApi()` + full recreate (the
      //   catch around `ensureConnected()` in ensureBaichuanClient).
      //
      // Calling `cleanupBaichuanApi()` here would defeat all of that:
      // it sets `_closed=true` (next ensureBaichuanClient destroys +
      // recreates from scratch), and worse it tears down any consumer
      // registered against `api.simpleEventListeners` — like the lib
      // email-push auto-bridge — for the entire gap until the next
      // `ensureBaichuanClient` call (which on battery cams can be
      // minutes). We deliberately don't.

      // Call custom close handler if provided
      if (callbacks.onClose) {
        try {
          await callbacks.onClose();
        } catch {
          // ignore
        }
      }
    };

    // Attach listeners
    api.client.on("error", this.errorListener);
    api.client.on("close", this.closeListener);
  }

  /**
   * Centralized cleanup method for Baichuan API
   * Removes all listeners, closes connection, and resets state
   */
  async cleanupBaichuanApi(): Promise<void> {
    if (!this.baichuanApi || this.cleanupInProgress) {
      return;
    }

    this.cleanupInProgress = true;
    try {
      const api = this.baichuanApi;

      // Unsubscribe from events first
      await this.unsubscribeFromEvents();

      // Call before cleanup hook
      await this.onBeforeCleanup();

      // Remove all listeners
      if (this.closeListener) {
        try {
          api.client.off("close", this.closeListener);
        } catch {
          // ignore
        }
        this.closeListener = undefined;
      }

      if (this.errorListener) {
        try {
          api.client.off("error", this.errorListener);
        } catch {
          // ignore
        }
        this.errorListener = undefined;
      }

      // Close connection best-effort.
      // Don't rely on isSocketConnected(): if the local socket state is inconsistent,
      // skipping close can leave a "ghost" session on the device.
      try {
        await api.close();
      } catch {
        // ignore
      }

      // Stop ping and auto-renewal intervals
      this.stopConnectionMaintenance();

      // Stop event check interval
      this.stopEventCheck();
    } finally {
      // Reset state ALWAYS — even if an earlier step threw.
      // This prevents the client from being permanently "stuck":
      // if baichuanApi remains set with a destroyed socket pool,
      // ensureBaichuanClient() will repeatedly crash on the `client` getter
      // and never recover.
      this.baichuanApi = undefined;
      this.ensureClientPromise = undefined;
      this.cleanupInProgress = false;
    }
  }

  /**
   * Get all active Baichuan connections (main client only now)
   */
  private getAllActiveConnections(): ReolinkBaichuanApi[] {
    const connections: ReolinkBaichuanApi[] = [];

    // Add main connection if it exists and is ready (safe, never throws)
    if (this.baichuanApi?.isReady) {
      connections.push(this.baichuanApi);
    }

    return connections;
  }

  /**
   * Start ping and auto-renewal maintenance for TCP connections
   */
  private startConnectionMaintenance(api: ReolinkBaichuanApi): void {
    const logger = this.getBaichuanLogger();

    // Stop any existing intervals
    this.stopConnectionMaintenance();

    // Ping every 30 seconds to keep all connections alive
    this.pingInterval = setInterval(async () => {
      if (!this.baichuanApi || this.baichuanApi !== api) {
        return; // Connection changed, stop this interval
      }

      try {
        // Get all active connections (main + stream clients)
        const allConnections = this.getAllActiveConnections();
        logger.debug(`Pinging ${allConnections.length} connections`);

        if (allConnections.length === 0) {
          this.consecutivePingFailures++;
          logger.debug(
            `No active connections found, failures=${this.consecutivePingFailures}`,
          );

          if (this.consecutivePingFailures >= 3) {
            logger.log("No active connections detected, renewing connection");
            await this.cleanupBaichuanApi();
            this.consecutivePingFailures = 0;
          }
          return;
        }

        // Ping all connections using the specific ping method
        const pingResults = await Promise.allSettled(
          allConnections.map(async (conn) => {
            try {
              await conn.ping();
              return { success: true, conn };
            } catch (e) {
              return { success: false, conn, error: e };
            }
          }),
        );

        // Check results
        const failedPings = pingResults.filter(
          (r) =>
            r.status === "rejected" ||
            (r.status === "fulfilled" && !r.value.success),
        );

        if (failedPings.length > 0) {
          this.consecutivePingFailures++;
          logger.debug(
            `Ping failed for ${failedPings.length}/${allConnections.length} connections, failures=${this.consecutivePingFailures}`,
          );

          if (this.consecutivePingFailures >= 3) {
            logger.log(
              `Multiple ping failures detected (${failedPings.length} connections), renewing connection`,
            );
            await this.cleanupBaichuanApi();
            this.consecutivePingFailures = 0;
          }
        } else {
          // All pings successful, reset failure counter
          this.consecutivePingFailures = 0;
          if (allConnections.length > 1) {
            logger.debug(
              `Ping successful for all ${allConnections.length} connections`,
            );
          }
        }
      } catch (e) {
        logger.debug(`Error in ping check: ${e?.message || String(e)}`);
      }
    }, 30_000); // Every 30 seconds

    // Auto-renewal every 5 minutes if no active streams
    this.autoRenewInterval = setInterval(async () => {
      if (!this.baichuanApi || this.baichuanApi !== api) {
        return; // Connection changed, stop this interval
      }

      try {
        // Check if there are active streams
        const hasActiveStreams =
          this.getStreamManager?.()?.hasActiveStreams() ?? false;

        if (!hasActiveStreams) {
          logger.log(
            "No active streams detected, renewing connection (auto-renewal)",
          );
          await this.cleanupBaichuanApi();
        } else {
          logger.debug("Active streams detected, skipping auto-renewal");
        }
      } catch (e) {
        logger.debug(`Error in auto-renewal check: ${e?.message || String(e)}`);
      }
    }, 5 * 60_000); // Every 5 minutes
  }

  /**
   * Stop ping and auto-renewal maintenance
   */
  private stopConnectionMaintenance(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
    if (this.autoRenewInterval) {
      clearInterval(this.autoRenewInterval);
      this.autoRenewInterval = undefined;
    }
    this.consecutivePingFailures = 0;
  }

  /**
   * Start event check to monitor if events are being received.
   * The library (ReolinkBaichuanApi) handles auto-recovery of lost subscriptions
   * internally via its built-in event watchdog. This plugin-level check is a
   * complementary fallback that performs a full unsub/resub cycle at the plugin
   * level if no events arrive for an extended period.
   *
   * It also acts as a recovery mechanism: if the event subscription was lost
   * during a reconnection storm (e.g. subscribeToEvents failed with ECONNREFUSED
   * but the connection was later re-established by the streaming infrastructure),
   * this check will detect that eventSubscriptionActive is false on a live
   * connection and re-subscribe automatically.
   */
  private startEventCheck(api: ReolinkBaichuanApi): void {
    const logger = this.getBaichuanLogger();

    // Stop any existing interval
    this.stopEventCheck();

    // Check every 60s if events are being received
    this.eventCheckInterval = setInterval(async () => {
      if (!this.baichuanApi || this.baichuanApi !== api) {
        return; // Connection changed, stop this interval
      }

      // If event subscription is not active but the connection is live,
      // attempt to re-subscribe. This handles the case where the camera
      // rebooted and the onClose retries exhausted before it came back up,
      // leaving a live socket with no active event subscription.
      if (!this.eventSubscriptionActive) {
        if (this.baichuanApi?.client.isSocketConnected()) {
          try {
            await this.subscribeToEvents();
          } catch (e) {
            logger.debug(
              `Event check: auto-subscribe attempt failed: ${e?.message || String(e)}`,
            );
          }
        }
        return;
      }

      // Battery cameras on UDP transport spend most of their lifetime
      // asleep — event silence is the *normal* operating mode, not a
      // failure. Running `unsubscribeFromEvents + subscribeToEvents`
      // here wakes the device every 10 minutes for no real benefit
      // (the cam emits its own sleep/awake push when it wakes for
      // motion, and the lib's own watchdog has the same UDP-skip
      // guard for the same reason).
      if (this.isBatteryDevice()) {
        logger.debug?.(
          "Event check: skipping silence-based restart for battery camera (UDP sleep is normal)",
        );
        return;
      }

      try {
        const now = Date.now();
        const timeSinceLastEvent = now - this.lastEventTime;
        const tenMinutesMs = 10 * 60 * 1000;

        // Rate-limit triggered restarts: never restart more than once per
        // 10 minutes. A persistently-quiet camera otherwise gets a full
        // unsub/resub cycle on every qualifying check window.
        const canRestart =
          now - this.lastEventRestartTime >= tenMinutesMs;

        if (this.lastEventTime > 0 && timeSinceLastEvent > tenMinutesMs) {
          if (!canRestart) {
            logger.debug(
              "Event check: silence detected but skipping restart (backoff: last restart < 10min ago)",
            );
          } else {
            logger.log(
              `No events received in the last ${Math.round(timeSinceLastEvent / 60_000)} minutes, performing full plugin-level event restart`,
            );
            await this.unsubscribeFromEvents(true);
            await this.subscribeToEvents(true);
            this.lastEventRestartTime = Date.now();
          }
        } else if (this.lastEventTime === 0) {
          const timeSinceSubscription = now - (this.connectionTime || now);
          if (timeSinceSubscription > tenMinutesMs) {
            if (!canRestart) {
              logger.debug(
                "Event check: no events since subscription but skipping restart (backoff: last restart < 10min ago)",
              );
            } else {
              logger.log(
                `No events received since subscription (${Math.round(timeSinceSubscription / 60_000)} minutes ago), performing full plugin-level event restart`,
              );
              await this.unsubscribeFromEvents(true);
              await this.subscribeToEvents(true);
              this.lastEventRestartTime = Date.now();
            }
          }
        }
      } catch (e) {
        logger.debug(`Error in event check: ${e?.message || String(e)}`);
      }
    }, 60_000);
  }

  /**
   * Stop event check interval
   */
  private stopEventCheck(): void {
    if (this.eventCheckInterval) {
      clearInterval(this.eventCheckInterval);
      this.eventCheckInterval = undefined;
    }
    this.lastEventTime = 0;
  }

  /**
   * Subscribe to Baichuan simple events
   */
  async subscribeToEvents(silent: boolean = false): Promise<void> {
    const logger = this.getBaichuanLogger();
    const callbacks = this.getConnectionCallbacks();
    const existingClientInfo = this.baichuanApi
      ? `connected=${this.baichuanApi.client.isSocketConnected()}, loggedIn=${this.baichuanApi.client.loggedIn}`
      : "no client";

    logger.debug(
      `subscribeToEvents() called: silent=${silent}, existingClient=[${existingClientInfo}], eventSubscriptionActive=${this.eventSubscriptionActive}`,
    );

    if (!callbacks.onSimpleEvent) {
      return;
    }

    // Serialize concurrent subscribe calls: if one is already in-flight, wait
    // for it to finish instead of racing through the unsubscribe/subscribe flow.
    if (this.subscribeToEventsPromise) {
      logger.debug("subscribeToEvents: another call in-flight, awaiting");
      try {
        await this.subscribeToEventsPromise;
      } catch {
        // ignore — the caller that owns the promise handles errors
      }
      return;
    }

    // If already subscribed and connection is valid, return
    if (this.eventSubscriptionActive && this.baichuanApi) {
      if (
        this.baichuanApi.client.isSocketConnected() &&
        this.baichuanApi.client.loggedIn
      ) {
        logger.debug("Event subscription already active");
        return;
      }
      // Connection is invalid, reset subscription state
      this.eventSubscriptionActive = false;
    }

    this.subscribeToEventsPromise = this.subscribeToEventsInternal(silent, logger, callbacks);
    try {
      await this.subscribeToEventsPromise;
    } finally {
      this.subscribeToEventsPromise = undefined;
    }
  }

  private async subscribeToEventsInternal(
    silent: boolean,
    logger: BaichuanLogger,
    callbacks: BaichuanConnectionCallbacks,
  ): Promise<void> {
    // Unsubscribe first if handler exists (idempotent)
    await this.unsubscribeFromEvents(silent);

    // Get Baichuan client connection
    logger.debug("subscribeToEvents: calling ensureBaichuanClient...");
    const api = await this.ensureBaichuanClient();
    logger.debug(
      `subscribeToEvents: ensureBaichuanClient returned, reused=${api === this.baichuanApi}`,
    );

    // Verify connection is ready
    if (!api.client.isSocketConnected() || !api.client.loggedIn) {
      logger.warn("Cannot subscribe to events: connection not ready");
      return;
    }

    // Check if event subscription is enabled
    if (
      callbacks.getEventSubscriptionEnabled &&
      !callbacks.getEventSubscriptionEnabled()
    ) {
      logger.debug("Event subscription disabled");
      return;
    }

    // Subscribe to events with wrapper to track last event time
    try {
      // The outer `subscribeToEvents` already guards on `!callbacks.onSimpleEvent`
      // and returns before reaching this point. The narrowed local keeps
      // strict-null TS happy without changing the runtime contract.
      const originalHandler = callbacks.onSimpleEvent!;
      // Create and store the wrapped handler so it can be properly removed later
      this.currentWrappedEventHandler = (ev: ReolinkSimpleEvent) => {
        // Update last event time
        this.lastEventTime = Date.now();
        // Call original handler
        originalHandler(ev);
      };

      // onSimpleEvent no longer throws on initial subscribe failure;
      // the library watchdog handles auto-recovery internally.
      await api.onSimpleEvent(this.currentWrappedEventHandler);

      // NOTE: the email-push bus subscription used to live here, but
      // it's now owned by `ReolinkCamera.subscribeToEmailPushBus()`
      // because the bus is global and must outlive the Baichuan api —
      // battery cams routinely drop the api between motions, which
      // would silently drop SMTP events with an api-scoped bridge.

      this.eventSubscriptionActive = true;
      this.lastEventTime = Date.now(); // Initialize on subscription
      logger.debug("Subscribed to Baichuan events (library watchdog handles auto-recovery)");
    } catch (e) {
      logger.warn("Failed to subscribe to events", e?.message || String(e));
      this.eventSubscriptionActive = false;
    }
  }

  /**
   * Unsubscribe from Baichuan simple events
   * @param silent If true, don't log unsubscription messages
   */
  async unsubscribeFromEvents(silent: boolean = false): Promise<void> {
    const logger = this.getBaichuanLogger();

    // Only unsubscribe if we have an active subscription
    if (
      this.baichuanApi &&
      (this.eventSubscriptionActive || this.currentWrappedEventHandler)
    ) {
      try {
        // Use the stored wrapped handler reference so offSimpleEvent
        // actually finds and removes the correct listener.
        // Must await: offSimpleEvent is async and accesses the socket pool
        // internally. Without await, the rejection becomes unhandled when
        // api.close() destroys the pool before the promise settles.
        await this.baichuanApi.offSimpleEvent(this.currentWrappedEventHandler);
        this.currentWrappedEventHandler = undefined;
        logger.debug("Unsubscribed from Baichuan events");
      } catch (e) {
        logger.warn("Error unsubscribing from events", e?.message || String(e));
      }
    }

    this.eventSubscriptionActive = false;
  }

  /**
   * Create or get a dedicated Baichuan API session for streaming (used by StreamManager).
   * Always returns the main client - the library internally manages dedicated sockets.
   */
  async createStreamClient(streamKey: string): Promise<ReolinkBaichuanApi> {
    // Always return the main client - the library handles dedicated sockets internally
    return await this.ensureBaichuanClient();
  }

  /**
   * Refresh the list of active user sessions from the device.
   * This method uses storageSettings which must be defined in subclasses.
   * Uses ensureClient() if available (for camera with nvrDevice), otherwise ensureBaichuanClient().
   */
  protected async refreshUserSessionsList(): Promise<void> {
    const logger = this.getBaichuanLogger();

    try {
      // Use ensureClient() if available (e.g., camera with nvrDevice), otherwise use ensureBaichuanClient()
      const api = (this as any).ensureClient
        ? await (this as any).ensureClient()
        : await this.ensureBaichuanClient();

      const sessionStrings = await api.getOnlineUserSessionsForUi();
      (this as any).storageSettings.values.userSessions = sessionStrings;
    } catch (e) {
      const errorMsg = e?.message || String(e);
      logger.error(`[Sessions] Failed to fetch user sessions: ${errorMsg}`);

      // Update setting with error message
      // Note: storageSettings must be defined in subclasses
      (this as any).storageSettings.values.userSessions = [
        `Error fetching sessions: ${errorMsg}`,
        `Timestamp: ${new Date().toLocaleString()}`,
      ];
      throw e;
    }
  }
}
