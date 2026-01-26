import type {
  BaichuanClientOptions,
  ReolinkBaichuanApi,
  ReolinkSimpleEvent,
} from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
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
  private readonly reconnectBackoffMs: number = 2000; // 2 seconds minimum between reconnects
  private eventSubscriptionActive: boolean = false;
  private lastEventTime: number = 0;
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
    // Prevent concurrent login storms - check promise first
    if (this.ensureClientPromise) return await this.ensureClientPromise;

    // Reuse existing client if socket is still connected and logged in
    // Check this AFTER checking the promise to avoid race conditions
    if (this.baichuanApi) {
      const isConnected = this.baichuanApi.client.isSocketConnected();
      const isLoggedIn = this.baichuanApi.client.loggedIn;

      // Only reuse if both conditions are true
      if (isConnected && isLoggedIn) {
        return this.baichuanApi;
      }

      // If socket is not connected or not logged in, cleanup the stale client
      // This prevents leaking connections when the socket appears connected but isn't
      const logger = this.getBaichuanLogger();
      logger.log(
        `Stale client detected: connected=${isConnected}, loggedIn=${isLoggedIn}, cleaning up`,
      );
      await this.cleanupBaichuanApi();
    }

    // Apply backoff to avoid aggressive reconnection after disconnection
    if (this.lastDisconnectTime > 0) {
      const timeSinceDisconnect = Date.now() - this.lastDisconnectTime;
      if (timeSinceDisconnect < this.reconnectBackoffMs) {
        const waitTime = this.reconnectBackoffMs - timeSinceDisconnect;
        const logger = this.getBaichuanLogger();
        logger.log(`Waiting ${waitTime}ms before reconnection (backoff)`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    this.ensureClientPromise = (async () => {
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
      if (!this.baichuanApi || this.baichuanApi !== api) {
        // This close event is for a different/old client, ignore it
        logger.debug("Close event for stale client, ignoring");
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
      const timeSinceLastDisconnect = now - this.lastDisconnectTime;
      this.lastDisconnectTime = now;

      logger.log(
        `Socket closed, resetting client state for reconnection (last disconnect ${timeSinceLastDisconnect}ms ago)`,
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
    if (!this.baichuanApi) {
      return;
    }

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

    // Close connection if still connected
    try {
      if (api.client.isSocketConnected()) {
        await api.close();
      }
    } catch {
      // ignore
    }

    // Stop ping and auto-renewal intervals
    this.stopConnectionMaintenance();

    // Stop event check interval
    this.stopEventCheck();

    // Reset state
    this.baichuanApi = undefined;
    this.ensureClientPromise = undefined;
  }

  /**
   * Get all active Baichuan connections (main client only now)
   */
  private getAllActiveConnections(): ReolinkBaichuanApi[] {
    const connections: ReolinkBaichuanApi[] = [];

    // Add main connection if exists and is valid
    if (this.baichuanApi) {
      const isConnected = this.baichuanApi.client.isSocketConnected();
      const isLoggedIn = this.baichuanApi.client.loggedIn;
      if (isConnected && isLoggedIn) {
        connections.push(this.baichuanApi);
      }
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
   * Start event check to monitor if events are being received
   */
  private startEventCheck(api: ReolinkBaichuanApi): void {
    const logger = this.getBaichuanLogger();

    // Stop any existing interval
    this.stopEventCheck();

    // Check every minute if events are being received
    this.eventCheckInterval = setInterval(async () => {
      if (!this.baichuanApi || this.baichuanApi !== api) {
        return; // Connection changed, stop this interval
      }

      // Only check if event subscription is active
      if (!this.eventSubscriptionActive) {
        return;
      }

      try {
        const now = Date.now();
        const timeSinceLastEvent = now - this.lastEventTime;
        const fiveMinutesMs = 5 * 60 * 1000;

        if (this.lastEventTime > 0 && timeSinceLastEvent > fiveMinutesMs) {
          logger.log(
            `No events received in the last ${Math.round(timeSinceLastEvent / 60_000)} minutes, restarting event listener`,
          );
          // Restart event subscription
          await this.unsubscribeFromEvents(true);
          await this.subscribeToEvents(true);
        } else if (this.lastEventTime === 0) {
          // If lastEventTime is 0, it means we just subscribed but haven't received any events yet
          // Wait a bit longer before considering it a problem
          const timeSinceSubscription = now - (this.connectionTime || now);
          if (timeSinceSubscription > fiveMinutesMs) {
            logger.log(
              `No events received since subscription (${Math.round(timeSinceSubscription / 60_000)} minutes ago), restarting event listener`,
            );
            await this.unsubscribeFromEvents(true);
            await this.subscribeToEvents(true);
          }
        }
      } catch (e) {
        logger.debug(`Error in event check: ${e?.message || String(e)}`);
      }
    }, 5_000); // Check every minute
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

    if (!callbacks.onSimpleEvent) {
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

    // Unsubscribe first if handler exists (idempotent)
    await this.unsubscribeFromEvents(silent);

    // Get Baichuan client connection
    const api = await this.ensureBaichuanClient();

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
      const originalHandler = callbacks.onSimpleEvent;
      const wrappedHandler = (ev: ReolinkSimpleEvent) => {
        // Update last event time
        this.lastEventTime = Date.now();
        // Call original handler
        originalHandler(ev);
      };

      await api.onSimpleEvent(wrappedHandler);
      this.eventSubscriptionActive = true;
      this.lastEventTime = Date.now(); // Initialize on subscription
      logger.debug("Subscribed to Baichuan events");
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
    const callbacks = this.getConnectionCallbacks();

    // Only unsubscribe if we have an active subscription
    if (
      this.eventSubscriptionActive &&
      this.baichuanApi &&
      callbacks.onSimpleEvent
    ) {
      try {
        this.baichuanApi.offSimpleEvent(callbacks.onSimpleEvent);
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

      logger.log("[Sessions] Fetching active user sessions from device...");

      const sessions = await api.getOnlineUserList();

      // Get current socket session ID if available
      let socketSessionId: string | undefined;
      try {
        socketSessionId = api.client.getSocketSessionId();
      } catch {
        // getSocketSessionId might not be available on all clients
      }

      // Format sessions as array of readable strings
      const sessionStrings: string[] = [];

      // Add header with timestamp and socket session ID
      const timestamp = new Date().toLocaleString();
      sessionStrings.push(`Last updated: ${timestamp}`);
      if (socketSessionId) {
        sessionStrings.push(`Current socket session ID: ${socketSessionId}`);
      }
      sessionStrings.push(""); // Empty line separator

      // Parse sessions data (handle different response formats)
      let sessionCount = 0;
      const parseSessions = (data: any, prefix: string = ""): void => {
        if (Array.isArray(data)) {
          data.forEach((session: any, index: number) => {
            sessionCount++;
            const sessionInfo = formatSessionInfo(session, index + 1);
            sessionStrings.push(sessionInfo);
          });
        } else if (data && typeof data === "object") {
          // Handle nested objects
          for (const [key, value] of Object.entries(data)) {
            if (Array.isArray(value)) {
              value.forEach((session: any, index: number) => {
                sessionCount++;
                const sessionInfo = formatSessionInfo(session, index + 1, key);
                sessionStrings.push(sessionInfo);
              });
            } else if (value && typeof value === "object") {
              parseSessions(value, prefix ? `${prefix}.${key}` : key);
            } else {
              // Single session object
              sessionCount++;
              const sessionInfo = formatSessionInfo(data, 1);
              sessionStrings.push(sessionInfo);
              return; // Only process once
            }
          }
        }
      };

      // Helper function to format session info as readable string
      const formatSessionInfo = (
        session: any,
        index: number,
        group?: string,
      ): string => {
        const parts: string[] = [];

        if (group) {
          parts.push(`[${group}]`);
        }
        parts.push(`Session ${index}:`);

        // Extract common fields
        if (session.userName !== undefined) {
          parts.push(`User: ${session.userName}`);
        }
        if (session.user !== undefined) {
          parts.push(`User: ${session.user}`);
        }
        if (session.ip !== undefined) {
          parts.push(`IP: ${session.ip}`);
        }
        if (session.ipAddress !== undefined) {
          parts.push(`IP: ${session.ipAddress}`);
        }
        if (session.port !== undefined) {
          parts.push(`Port: ${session.port}`);
        }
        if (session.sessionId !== undefined) {
          parts.push(`Session ID: ${session.sessionId}`);
        }
        if (session.id !== undefined) {
          parts.push(`ID: ${session.id}`);
        }
        if (session.loginTime !== undefined) {
          parts.push(`Login Time: ${session.loginTime}`);
        }
        if (session.time !== undefined) {
          parts.push(`Time: ${session.time}`);
        }
        if (session.status !== undefined) {
          parts.push(`Status: ${session.status}`);
        }

        // If no common fields found, show all fields
        if (parts.length === (group ? 2 : 1)) {
          const allFields = Object.entries(session)
            .map(([key, value]) => `${key}: ${value}`)
            .join(", ");
          parts.push(allFields);
        }

        return parts.join(" | ");
      };

      parseSessions(sessions);

      // If no sessions found, add a message
      if (sessionCount === 0) {
        sessionStrings.push("No active sessions found");
      }

      // Update the setting with the formatted session strings
      // Note: storageSettings must be defined in subclasses
      (this as any).storageSettings.values.userSessions = sessionStrings;

      logger.log(`[Sessions] Retrieved ${sessionCount} active session(s)`);
      if (socketSessionId) {
        logger.debug(
          `[Sessions] Current socket session ID: ${socketSessionId}`,
        );
      }
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
