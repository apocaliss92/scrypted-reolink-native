import type { BaichuanClientOptions, ReolinkBaichuanApi, ReolinkSimpleEvent } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import { ScryptedDeviceBase } from "@scrypted/sdk";
import { createBaichuanApi, type BaichuanTransport } from "./connect";

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

    constructor(baseLogger: Console, deviceName: string, isDebugEnabledCallback: () => boolean) {
        this.baseLogger = baseLogger;
        this.deviceName = deviceName;
        this.isDebugEnabledCallback = isDebugEnabledCallback;
    }

    private formatMessage(level: string, ...args: any[]): string {
        const timestamp = new Date().toLocaleString();
        const prefix = `[${this.deviceName}] [${timestamp}] [${level}]`;
        return `${prefix} ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')}`;
    }

    log(...args: any[]): void {
        this.baseLogger.log(this.formatMessage('LOG', ...args));
    }

    error(...args: any[]): void {
        this.baseLogger.error(this.formatMessage('ERROR', ...args));
    }

    warn(...args: any[]): void {
        this.baseLogger.warn(this.formatMessage('WARN', ...args));
    }

    debug(...args: any[]): void {
        if (this.isDebugEnabledCallback()) {
            this.baseLogger.debug(this.formatMessage('DEBUG', ...args));
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
        this.baseLogger.info(this.formatMessage('INFO', ...data));
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
        if (typeof (this.baseLogger as any).profile === 'function') {
            (this.baseLogger as any).profile(label);
        }
    }

    profileEnd(label?: string): void {
        if (typeof (this.baseLogger as any).profileEnd === 'function') {
            (this.baseLogger as any).profileEnd(label);
        }
    }

    timeStamp(label?: string): void {
        if (typeof (this.baseLogger as any).timeStamp === 'function') {
            (this.baseLogger as any).timeStamp(label);
        }
    }

    context(...data: any[]): void {
        if (typeof (this.baseLogger as any).context === 'function') {
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
    // Map of stream clients keyed by streamKey (profile + variantType)
    private streamClients = new Map<string, ReolinkBaichuanApi>();

    constructor(nativeId: string, transport: BaichuanTransport) {
        super(nativeId);
        this.transport = transport
    }

    private errorListener?: (err: unknown) => void;
    private closeListener?: () => void;
    private lastDisconnectTime: number = 0;
    private readonly reconnectBackoffMs: number = 2000; // 2 seconds minimum between reconnects
    private eventSubscriptionActive: boolean = false;

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
     * Get connection inputs for creating a stream client for a specific streamKey
     * This method is called by createStreamClient to get the inputs needed to create a new client
     * @param streamKey The unique stream key (e.g., "composite_default_main", "channel_0_main", etc.)
     */
    protected abstract getStreamClientInputs(): BaichuanConnectionConfig;

    /**
     * Get a Baichuan logger instance with formatting and debug control
     * This logger implements Console interface and can be used everywhere
     */
    public getBaichuanLogger(): BaichuanLogger {
        return new BaichuanLogger(this.console, this.getDeviceName(), () => this.isDebugEnabled());
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
            logger.log(`Stale client detected: connected=${isConnected}, loggedIn=${isLoggedIn}, cleaning up`);
            await this.cleanupBaichuanApi();
        }

        // Apply backoff to avoid aggressive reconnection after disconnection
        if (this.lastDisconnectTime > 0) {
            const timeSinceDisconnect = Date.now() - this.lastDisconnectTime;
            if (timeSinceDisconnect < this.reconnectBackoffMs) {
                const waitTime = this.reconnectBackoffMs - timeSinceDisconnect;
                const logger = this.getBaichuanLogger();
                logger.log(`Waiting ${waitTime}ms before reconnection (backoff)`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
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
                    throw new Error('Socket not connected after login');
                }

                // Attach listeners
                this.attachBaichuanListeners(api);

                this.baichuanApi = api;
                this.connectionTime = Date.now();

                return api;
            }
            catch (e) {
                // Apply backoff for connection failures too, otherwise multiple callers can hammer connect().
                this.lastDisconnectTime = Date.now();
                // Ensure state is reset so next attempt is clean.
                await this.cleanupBaichuanApi();
                throw e;
            }
        })();

        try {
            return await this.ensureClientPromise;
        }
        finally {
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
            const msg = (err as any)?.message || (err as any)?.toString?.() || String(err);

            // Only log if it's not a recoverable error to avoid spam
            if (typeof msg === 'string' && (
                msg.includes('Baichuan socket closed') ||
                msg.includes('Baichuan UDP stream closed') ||
                msg.includes('Not running')
            )) {
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
                logger.debug('Close event for stale client, ignoring');
                return;
            }

            try {
                const wasConnected = api.client.isSocketConnected();
                const wasLoggedIn = api.client.loggedIn;
                logger.log(`Connection state before close: connected=${wasConnected}, loggedIn=${wasLoggedIn}`);

                // Try to get last message info if available
                const client = api.client as any;
                if (client?.lastRx || client?.lastTx) {
                    logger.debug(`Last message info: lastRx=${JSON.stringify(client.lastRx)}, lastTx=${JSON.stringify(client.lastTx)}`);
                }
            }
            catch (e) {
                logger.debug(`Could not get connection state: ${e?.message || String(e)}`);
            }

            const now = Date.now();
            const timeSinceLastDisconnect = now - this.lastDisconnectTime;
            this.lastDisconnectTime = now;

            logger.log(`Socket closed, resetting client state for reconnection (last disconnect ${timeSinceLastDisconnect}ms ago)`);

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

        // Cleanup all stream clients
        await this.cleanupStreamClients();

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

        // Reset state
        this.baichuanApi = undefined;
        this.ensureClientPromise = undefined;
    }

    /**
     * Subscribe to Baichuan simple events
     */
    async subscribeToEvents(): Promise<void> {
        const logger = this.getBaichuanLogger();
        const callbacks = this.getConnectionCallbacks();

        if (!callbacks.onSimpleEvent) {
            return;
        }

        // If already subscribed and connection is valid, return
        if (this.eventSubscriptionActive && this.baichuanApi) {
            if (this.baichuanApi.client.isSocketConnected() && this.baichuanApi.client.loggedIn) {
                logger.debug('Event subscription already active');
                return;
            }
            // Connection is invalid, reset subscription state
            this.eventSubscriptionActive = false;
        }

        // Unsubscribe first if handler exists (idempotent)
        await this.unsubscribeFromEvents();

        // Get Baichuan client connection
        const api = await this.ensureBaichuanClient();

        // Verify connection is ready
        if (!api.client.isSocketConnected() || !api.client.loggedIn) {
            logger.warn('Cannot subscribe to events: connection not ready');
            return;
        }

        // Check if event subscription is enabled
        if (callbacks.getEventSubscriptionEnabled && !callbacks.getEventSubscriptionEnabled()) {
            logger.debug('Event subscription disabled');
            return;
        }

        // Subscribe to events
        try {
            await api.onSimpleEvent(callbacks.onSimpleEvent);
            this.eventSubscriptionActive = true;
            logger.log('Subscribed to Baichuan events');
        }
        catch (e) {
            logger.warn('Failed to subscribe to events', e?.message || String(e));
            this.eventSubscriptionActive = false;
        }
    }

    /**
     * Unsubscribe from Baichuan simple events
     */
    async unsubscribeFromEvents(): Promise<void> {
        const logger = this.getBaichuanLogger();
        const callbacks = this.getConnectionCallbacks();

        // Only unsubscribe if we have an active subscription
        if (this.eventSubscriptionActive && this.baichuanApi && callbacks.onSimpleEvent) {
            try {
                this.baichuanApi.offSimpleEvent(callbacks.onSimpleEvent);
                logger.debug('Unsubscribed from Baichuan events');
            }
            catch (e) {
                logger.warn('Error unsubscribing from events', e?.message || String(e));
            }
        }

        this.eventSubscriptionActive = false;
    }

    private async createNewClient(): Promise<ReolinkBaichuanApi> {
        const config = this.getStreamClientInputs();
        const logger = this.getBaichuanLogger();

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

        return api;
    }

    /**
     * Create or get a dedicated Baichuan API session for streaming (used by StreamManager).
     * Returns an existing client if one exists for the same streamKey, otherwise creates a new one.
     * @param streamKey The unique stream key (e.g., "composite_default_main", "channel_0_main", etc.)
     */
    async createStreamClient(streamKey: string): Promise<ReolinkBaichuanApi> {
        const logger = this.getBaichuanLogger();

        // Check if a client already exists for this streamKey
        const existingClient = this.streamClients.get(streamKey);
        if (existingClient) {
            // Verify the client is still valid (connected and logged in)
            const isConnected = existingClient.client.isSocketConnected();
            const isLoggedIn = existingClient.client.loggedIn;

            if (isConnected && isLoggedIn) {
                // Return existing valid client
                logger.log(`Reusing existing stream client for streamKey=${streamKey}`);
                return existingClient;
            }

            logger.log(`Stale stream client detected for streamKey=${streamKey}, recreating`);
            try {
                if (existingClient.client.isSocketConnected()) {
                    await existingClient.close();
                }
            } catch {
                // ignore cleanup errors
            }
            this.streamClients.delete(streamKey);
        }

        // Create new client for this streamKey
        const api = await this.createNewClient();

        // Store in map for future reuse
        this.streamClients.set(streamKey, api);
        logger.log(`Created new stream client for streamKey=${streamKey}`);

        // Clean up when client closes
        api.client.once('close', () => {
            const currentClient = this.streamClients.get(streamKey);
            if (currentClient === api) {
                this.streamClients.delete(streamKey);
            }
        });

        return api;
    }

    /**
     * Cleanup all stream clients (called during device cleanup)
     */
    async cleanupStreamClients(): Promise<void> {
        const clients = Array.from(this.streamClients.values());
        this.streamClients.clear();

        await Promise.allSettled(
            clients.map(async (api) => {
                try {
                    if (api.client.isSocketConnected()) {
                        await api.close();
                    }
                } catch {
                    // ignore cleanup errors
                }
            })
        );
    }
}

