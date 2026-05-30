import type {
  BaichuanClientOptions,
  EmailPushEvent,
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
}

export interface BaichuanConnectionCallbacks {
  onError?: (err: unknown) => void;
  onClose?: () => void | Promise<void>;
  onSimpleEvent?: (ev: ReolinkSimpleEvent) => void;
  getEventSubscriptionEnabled?: () => boolean;
  /**
   * When provided, the base class binds the camera's api to the global
   * email-push bus filtered on `cameraId === emailPushCameraId()`. The
   * lib's `subscribeEmailPushEvents` converts each matching event into
   * a `ReolinkSimpleEvent` and dispatches it through `onSimpleEvent`,
   * so the camera's existing motion / AI handler lights up for SMTP-
   * delivered events with no extra wiring. Standalone cameras only —
   * leave undefined on NVR children where email-push isn't meaningful.
   */
  emailPushCameraId?: () => string;
  /**
   * Optional. When the email-push event carries an image attachment
   * (typical for `attachmentType=picture` on motion), the camera
   * receives the full event so it can republish the snapshot —
   * usually by updating its `lastPicture` cache so subsequent
   * `takePicture()` calls return the fresh thumbnail without waking
   * the camera. Invoked AFTER the simple-event dispatch so any motion
   * listener has already fired.
   */
  onEmailPushEvent?: (event: EmailPushEvent) => void;
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
  private currentWrappedEventHandler?: (ev: ReolinkSimpleEvent) => void;
  private currentEmailPushOff?: () => void;
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

      // Create new Baichuan client
      // BaichuanLogger implements Console, so it can be used directly
      const logger = this.getBaichuanLogger();
      try {
        const api = await createBaichuanApi({
          inputs: {
            host: config.host,
            username: config.username,
            password: config.password,
            uid: config.uid,
            logger,
            debugOptions: config.debugOptions,
            udpDiscoveryMethod: config.udpDiscoveryMethod,
          },
          transport: config.transport,
        });

        await api.login();

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
        `Socket closed, resetting client state for reconnection${timeSinceLastDisconnect != null ? ` (last disconnect ${timeSinceLastDisconnect}ms ago)` : " (first disconnect)"}`,
      );

      // Mark as disconnected immediately to prevent reuse
      // This prevents race conditions where ensureBaichuanClient might check
      // isSocketConnected() before cleanup completes
      const currentApi = this.baichuanApi;
      if (currentApi === api) {
        // Only cleanup if this is still the current API instance
        // This prevents cleanup of a new connection that was created
        // while the old one was closing
        await this.cleanupBaichuanApi();
      }

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

      try {
        const now = Date.now();
        const timeSinceLastEvent = now - this.lastEventTime;
        const tenMinutesMs = 10 * 60 * 1000;

        if (this.lastEventTime > 0 && timeSinceLastEvent > tenMinutesMs) {
          logger.log(
            `No events received in the last ${Math.round(timeSinceLastEvent / 60_000)} minutes, performing full plugin-level event restart`,
          );
          await this.unsubscribeFromEvents(true);
          await this.subscribeToEvents(true);
        } else if (this.lastEventTime === 0) {
          const timeSinceSubscription = now - (this.connectionTime || now);
          if (timeSinceSubscription > tenMinutesMs) {
            logger.log(
              `No events received since subscription (${Math.round(timeSinceSubscription / 60_000)} minutes ago), performing full plugin-level event restart`,
            );
            await this.unsubscribeFromEvents(true);
            await this.subscribeToEvents(true);
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

      // Bridge the global email-push bus into this api's onSimpleEvent
      // stream so the same wrapped handler above (and any other
      // listener) sees SMTP-delivered motion exactly like a native push.
      // Idempotent: if a previous off-handle is still around, release it.
      if (callbacks.emailPushCameraId) {
        if (this.currentEmailPushOff) {
          try {
            this.currentEmailPushOff();
          } catch {}
          this.currentEmailPushOff = undefined;
        }
        try {
          this.currentEmailPushOff = api.subscribeEmailPushEvents({
            cameraId: callbacks.emailPushCameraId(),
            channel: 0,
            ...(callbacks.onEmailPushEvent
              ? { onEvent: callbacks.onEmailPushEvent }
              : {}),
          });
          logger.debug("Bridged email-push bus to onSimpleEvent");
        } catch (e) {
          logger.warn(
            "Failed to bridge email-push events",
            e?.message || String(e),
          );
        }
      }

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
        if (this.currentEmailPushOff) {
          try {
            this.currentEmailPushOff();
          } catch {}
          this.currentEmailPushOff = undefined;
        }
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
