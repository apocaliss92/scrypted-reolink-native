import type { ReolinkBaichuanApi, ReolinkSimpleEvent } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import { ScryptedDeviceBase } from "@scrypted/sdk";
import { createBaichuanApi, type BaichuanTransport } from "./connect";

export interface BaichuanConnectionConfig {
    host: string;
    username: string;
    password: string;
    uid?: string;
    transport: BaichuanTransport;
    logger: Console;
    debugOptions?: any;
}

export interface BaichuanConnectionCallbacks {
    onError?: (err: unknown) => void;
    onClose?: () => void | Promise<void>;
    onSimpleEvent?: (ev: ReolinkSimpleEvent) => void;
    getEventSubscriptionEnabled?: () => boolean;
}

/**
 * Base class for managing Baichuan API connections with automatic reconnection,
 * listener management, and event subscription handling.
 */
export abstract class BaseBaichuanClass extends ScryptedDeviceBase {
    protected baichuanApi: ReolinkBaichuanApi | undefined;
    protected ensureClientPromise: Promise<ReolinkBaichuanApi> | undefined;
    protected connectionTime: number | undefined;
    
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
     * Get a logger instance
     */
    public abstract getLogger(): Console;

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
        // Reuse existing client if socket is still connected and logged in
        if (this.baichuanApi && this.baichuanApi.client.isSocketConnected() && this.baichuanApi.client.loggedIn) {
            return this.baichuanApi;
        }

        // Prevent concurrent login storms
        if (this.ensureClientPromise) return await this.ensureClientPromise;

        // Apply backoff to avoid aggressive reconnection after disconnection
        if (this.lastDisconnectTime > 0) {
            const timeSinceDisconnect = Date.now() - this.lastDisconnectTime;
            if (timeSinceDisconnect < this.reconnectBackoffMs) {
                const waitTime = this.reconnectBackoffMs - timeSinceDisconnect;
                const logger = this.getLogger();
                logger.log(`[BaichuanClient] Waiting ${waitTime}ms before reconnection (backoff)`);
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
            const api = await createBaichuanApi({
                inputs: {
                    host: config.host,
                    username: config.username,
                    password: config.password,
                    uid: config.uid,
                    logger: config.logger,
                    debugOptions: config.debugOptions,
                },
                transport: config.transport,
                logger: config.logger,
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
        const logger = this.getLogger();
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
                logger.debug(`[BaichuanClient] error (recoverable): ${msg}`);
                return;
            }
            logger.error(`[BaichuanClient] error: ${msg}`);
            
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
            try {
                const wasConnected = api.client.isSocketConnected();
                const wasLoggedIn = api.client.loggedIn;
                logger.log(`[BaichuanClient] Connection state before close: connected=${wasConnected}, loggedIn=${wasLoggedIn}`);

                // Try to get last message info if available
                const client = api.client as any;
                if (client?.lastRx || client?.lastTx) {
                    logger.log(`[BaichuanClient] Last message info: lastRx=${JSON.stringify(client.lastRx)}, lastTx=${JSON.stringify(client.lastTx)}`);
                }
            }
            catch (e) {
                logger.debug(`[BaichuanClient] Could not get connection state: ${e}`);
            }

            const now = Date.now();
            const timeSinceLastDisconnect = now - this.lastDisconnectTime;
            this.lastDisconnectTime = now;

            logger.log(`[BaichuanClient] Socket closed, resetting client state for reconnection (last disconnect ${timeSinceLastDisconnect}ms ago)`);

            // Cleanup
            await this.cleanupBaichuanApi();

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

        // Reset state
        this.baichuanApi = undefined;
        this.ensureClientPromise = undefined;
    }

    /**
     * Subscribe to Baichuan simple events
     */
    async subscribeToEvents(): Promise<void> {
        const logger = this.getLogger();
        const callbacks = this.getConnectionCallbacks();

        if (!callbacks.onSimpleEvent) {
            return;
        }

        // If already subscribed and connection is valid, return
        if (this.eventSubscriptionActive && this.baichuanApi) {
            if (this.baichuanApi.client.isSocketConnected() && this.baichuanApi.client.loggedIn) {
                logger.log('Event subscription already active');
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
            logger.log('Event subscription disabled');
            return;
        }

        // Subscribe to events
        try {
            await api.onSimpleEvent(callbacks.onSimpleEvent);
            this.eventSubscriptionActive = true;
            logger.log('Subscribed to Baichuan events');
        }
        catch (e) {
            logger.warn('Failed to subscribe to events', e);
            this.eventSubscriptionActive = false;
        }
    }

    /**
     * Unsubscribe from Baichuan simple events
     */
    async unsubscribeFromEvents(): Promise<void> {
        const logger = this.getLogger();
        const callbacks = this.getConnectionCallbacks();

        // Only unsubscribe if we have an active subscription
        if (this.eventSubscriptionActive && this.baichuanApi && callbacks.onSimpleEvent) {
            try {
                this.baichuanApi.offSimpleEvent(callbacks.onSimpleEvent);
                logger.log('Unsubscribed from Baichuan events');
            }
            catch (e) {
                logger.warn('Error unsubscribing from events', e);
            }
        }

        this.eventSubscriptionActive = false;
    }
}

