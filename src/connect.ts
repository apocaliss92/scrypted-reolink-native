import type { BaichuanClientOptions, ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };

export type BaichuanTransport = "tcp" | "udp";

export type BaichuanConnectInputs = {
    host: string;
    username: string;
    password: string;
    uid?: string;
    logger?: Console;
    debugOptions?: unknown;
    keepAliveInterval?: number;
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

export async function createBaichuanApi(inputs: BaichuanConnectInputs, transport: BaichuanTransport): Promise<ReolinkBaichuanApi> {
    const { ReolinkBaichuanApi } = await import("@apocaliss92/reolink-baichuan-js");

    const base: BaichuanClientOptions = {
        host: inputs.host,
        username: inputs.username,
        password: inputs.password,
        logger: inputs.logger,
        ...(inputs.debugOptions ? { debugOptions: inputs.debugOptions } : {}),
    };

    const attachErrorHandler = (api: ReolinkBaichuanApi) => {
        // Critical: BaichuanClient emits 'error'. If nobody listens, Node treats it as an
        // uncaught exception. Ensure we always have a listener.
        try {
            api.client.on("error", (err: unknown) => {
                const logger = inputs.logger;
                if (!logger) return;
                const msg = (err as any)?.message || (err as any)?.toString?.() || String(err);
                logger.error(`[BaichuanClient] error (${transport}) ${inputs.host}: ${msg}`);
            });
        } catch {
            // ignore
        }
    };

    if (transport === "tcp") {
        const api = new ReolinkBaichuanApi({
            ...base,
            keepAliveInterval: 10000,
            tcpSocketKeepAlive: true,
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
        udp: {
            mode: "uid",
            implementation: "neolink-v2",
            uid,
            host: inputs.host,
            broadcast: false,
        },
        keepAliveInterval: inputs.keepAliveInterval ?? 0,
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

export async function connectBaichuanWithTcpUdpFallback(
    inputs: BaichuanConnectInputs,
    onUdpFallback?: (info: UdpFallbackInfo) => void,
): Promise<{ api: ReolinkBaichuanApi; transport: BaichuanTransport }> {
    let tcpApi: ReolinkBaichuanApi | undefined;
    try {
        tcpApi = await createBaichuanApi(inputs, "tcp");
        await tcpApi.login();
        return { api: tcpApi, transport: "tcp" };
    }
    catch (e) {
        try {
            await tcpApi?.close();
        }
        catch {
            // ignore
        }

        if (!isTcpFailureThatShouldFallbackToUdp(e)) {
            throw e;
        }

        const uid = normalizeUid(inputs.uid);
        const uidMissing = !uid;

        onUdpFallback?.({
            host: inputs.host,
            uid,
            uidMissing,
            tcpError: e,
        });

        if (uidMissing) {
            throw new Error(
                `Baichuan TCP failed and this camera likely requires UDP/BCUDP. Set the Reolink UID in settings to continue (ip=${inputs.host}).`,
            );
        }

        const udpApi = await createBaichuanApi(inputs, "udp");
        await udpApi.login();
        return { api: udpApi, transport: "udp" };
    }
}
