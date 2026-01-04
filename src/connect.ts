import type { BaichuanClientOptions, ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };

export type BaichuanTransport = "tcp" | "udp";

export type BaichuanConnectInputs = {
    host: string;
    username: string;
    password: string;
    uid?: string;
    logger?: Console;
    debugOptions?: BaichuanClientOptions['debugOptions'];
};

export function normalizeUid(uid?: string): string | undefined {
    const v = uid?.trim();
    return v ? v : undefined;
}

export function maskUid(uid: string): string {
    const v = uid.trim();
    if (v.length <= 8) return v;
    return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

export function isTcpFailureThatShouldFallbackToUdp(e: unknown): boolean {
    const message = (e as any)?.message || (e as any)?.toString?.() || "";
    if (typeof message !== "string") return false;

    // Fallback only on transport/connection style failures.
    // Wrong credentials won't be fixed by switching to UDP.
    return (
        message.includes("ECONNREFUSED") ||
        message.includes("ETIMEDOUT") ||
        message.includes("EHOSTUNREACH") ||
        message.includes("ENETUNREACH") ||
        message.includes("socket hang up") ||
        message.includes("TCP connection timeout") ||
        message.includes("Baichuan socket closed")
    );
}

export async function createBaichuanApi(props: {
    inputs: BaichuanConnectInputs,
    transport: BaichuanTransport,
    logger: Console,
}): Promise<ReolinkBaichuanApi> {
    const { inputs, transport, logger } = props;
    const { ReolinkBaichuanApi } = await import("@apocaliss92/reolink-baichuan-js");

    const base: BaichuanClientOptions = {
        host: inputs.host,
        username: inputs.username,
        password: inputs.password,
        logger: logger, // Use the logger passed to createBaichuanApi, not inputs.logger
        debugOptions: inputs.debugOptions ?? {}
    };

    const attachErrorHandler = (api: ReolinkBaichuanApi) => {
        // Critical: BaichuanClient emits 'error'. If nobody listens, Node treats it as an
        // uncaught exception. Ensure we always have a listener.
        try {
            api.client.on("error", (err: unknown) => {
                if (!logger) return;
                const msg = (err as any)?.message || (err as any)?.toString?.() || String(err);
                // Only log if it's not a recoverable error to avoid spam
                if (typeof msg === 'string' && (
                    msg.includes('Baichuan socket closed') ||
                    msg.includes('Baichuan UDP stream closed') ||
                    msg.includes('Not running')
                )) {
                    // Silently ignore recoverable socket close errors and "Not running" errors
                    // "Not running" is common for UDP/battery cameras when sleeping or during initialization
                    return;
                }
                logger.error(`[BaichuanClient] error (${transport}) ${inputs.host}: ${msg}`);
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
        throw new Error("UID is required for battery cameras (BCUDP)");
    }

    const api = new ReolinkBaichuanApi({
        ...base,
        transport: "udp",
        uid,
        idleDisconnect: true,
    });
    attachErrorHandler(api);
    return api;
}

export type UdpFallbackInfo = {
    host: string;
    uid?: string;
    uidMissing: boolean;
    tcpError: unknown;
};

export type DeviceType = 'camera' | 'battery-cam' | 'nvr';

export type AutoDetectResult = {
    type: DeviceType;
    transport: BaichuanTransport;
    uid?: string;
    deviceInfo?: Record<string, string>;
    channelNum?: number;
};

/**
 * Simple ping check to verify IP is reachable
 */
async function pingHost(host: string, timeoutMs: number = 3000): Promise<boolean> {
    return new Promise((resolve) => {
        const { exec } = require('child_process');
        const platform = process.platform;
        const pingCmd = platform === 'win32' ? `ping -n 1 -w ${timeoutMs} ${host}` : `ping -c 1 -W ${Math.floor(timeoutMs / 1000)} ${host}`;
        
        exec(pingCmd, (error: any) => {
            resolve(!error);
        });
    });
}

/**
 * Auto-detect device type by trying TCP first, then UDP if needed.
 * - First: Ping the IP to verify it's reachable
 * - TCP success: Check if NVR (multiple channels) or regular camera
 * - TCP failure: Try UDP (always battery camera)
 */
export async function autoDetectDeviceType(
    inputs: BaichuanConnectInputs,
    logger: Console,
): Promise<AutoDetectResult> {
    const { host, username, password, uid } = inputs;

    // Ping the host first to verify it's reachable
    logger.log(`[AutoDetect] Pinging ${host}...`);
    const isReachable = await pingHost(host);
    if (!isReachable) {
        logger.warn(`[AutoDetect] Host ${host} is not reachable via ping, but continuing with connection attempt...`);
    } else {
        logger.log(`[AutoDetect] Host ${host} is reachable`);
    }

    // Try TCP first
    let tcpApi: ReolinkBaichuanApi | undefined;
    try {
        logger.log(`[AutoDetect] Trying TCP connection to ${host}...`);
        tcpApi = await createBaichuanApi({
            inputs: { host, username, password, logger },
            transport: 'tcp',
            logger,
        });
        await tcpApi.login();

        // Get device info to check if it's an NVR
        const deviceInfo = await tcpApi.getInfo();
        const { support } = await tcpApi.getDeviceCapabilities(0);
        const channelNum = support?.channelNum ?? 1;

        logger.log(`[AutoDetect] TCP connection successful. channelNum=${channelNum}`);

        // If channelNum > 1, it's likely an NVR
        if (channelNum > 1) {
            logger.log(`[AutoDetect] Detected NVR (${channelNum} channels)`);
            await tcpApi.close();
            return {
                type: 'nvr',
                transport: 'tcp',
                deviceInfo,
                channelNum,
            };
        }

        // Single channel device - regular camera
        logger.log(`[AutoDetect] Detected regular camera (single channel)`);
        await tcpApi.close();
        return {
            type: 'camera',
            transport: 'tcp',
            deviceInfo,
            channelNum: 1,
        };
    } catch (tcpError) {
        // TCP failed, try UDP (battery camera)
        if (tcpApi) {
            try {
                await tcpApi.close();
            } catch {
                // ignore
            }
        }

        if (!isTcpFailureThatShouldFallbackToUdp(tcpError)) {
            // Not a transport error, rethrow
            throw tcpError;
        }

        logger.log(`[AutoDetect] TCP failed, trying UDP (battery camera)...`);
        const normalizedUid = normalizeUid(uid);
        if (!normalizedUid) {
            throw new Error(
                `TCP connection failed and device likely requires UDP/BCUDP. UID is required for battery cameras (ip=${host}).`
            );
        }

        try {
            const udpApi = await createBaichuanApi({
                inputs: { host, username, password, uid: normalizedUid, logger },
                transport: 'udp',
                logger,
            });
            await udpApi.login();

            const deviceInfo = await udpApi.getInfo();
            logger.log(`[AutoDetect] UDP connection successful. Detected battery camera.`);
            await udpApi.close();

            return {
                type: 'battery-cam',
                transport: 'udp',
                uid: normalizedUid,
                deviceInfo,
                channelNum: 1,
            };
        } catch (udpError) {
            logger.error(`[AutoDetect] Both TCP and UDP failed. TCP error: ${tcpError}, UDP error: ${udpError}`);
            throw new Error(
                `Failed to connect via both TCP and UDP. TCP: ${(tcpError as any)?.message || tcpError}, UDP: ${(udpError as any)?.message || udpError}`
            );
        }
    }
}

// export async function connectBaichuanWithTcpUdpFallback(
//     inputs: BaichuanConnectInputs,
//     onUdpFallback?: (info: UdpFallbackInfo) => void,
// ): Promise<{ api: ReolinkBaichuanApi; transport: BaichuanTransport }> {
//     let tcpApi: ReolinkBaichuanApi | undefined;
//     try {
//         tcpApi = await createBaichuanApi(inputs, "tcp");
//         await tcpApi.login();
//         return { api: tcpApi, transport: "tcp" };
//     }
//     catch (e) {
//         try {
//             await tcpApi?.close();
//         }
//         catch {
//             // ignore
//         }

//         if (!isTcpFailureThatShouldFallbackToUdp(e)) {
//             throw e;
//         }

//         const uid = normalizeUid(inputs.uid);
//         const uidMissing = !uid;

//         onUdpFallback?.({
//             host: inputs.host,
//             uid,
//             uidMissing,
//             tcpError: e,
//         });

//         if (uidMissing) {
//             throw new Error(
//                 `Baichuan TCP failed and this camera likely requires UDP/BCUDP. Set the Reolink UID in settings to continue (ip=${inputs.host}).`,
//             );
//         }

//         const udpApi = await createBaichuanApi(inputs, "udp");
//         await udpApi.login();
//         return { api: udpApi, transport: "udp" };
//     }
// }
