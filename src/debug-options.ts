import type { DebugOptions } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };

/**
 * User-friendly debug log options enum
 */
export enum DebugLogOption {
    /** RTSP proxy/server debug logs */
    DebugRtsp = 'debugRtsp',
    /** Low-level tracing for recording-related commands */
    TraceRecordings = 'traceRecordings',
    /** Native stream tracing (stream tx/rx + H264/H265 + param sets) */
    TraceNativeStream = 'traceNativeStream',
    /** Talkback tracing */
    TraceTalk = 'traceTalk',
    /** Event tracing */
    TraceEvents = 'traceEvents',
}

/**
 * Maps user-friendly enum values to API DebugOptions keys
 */
export function mapDebugLogToApiOption(option: DebugLogOption): keyof DebugOptions | null {
    const mapping: Record<DebugLogOption, keyof DebugOptions | null> = {
        [DebugLogOption.DebugRtsp]: 'debugRtsp',
        [DebugLogOption.TraceRecordings]: 'traceRecordings',
        [DebugLogOption.TraceNativeStream]: 'traceNativeStream',
        [DebugLogOption.TraceTalk]: 'traceTalk',
        [DebugLogOption.TraceEvents]: 'traceEvents',
    };
    return mapping[option];
}

/**
 * Convert array of DebugLogOption enum values to API DebugOptions
 * Only includes options that are relevant to the API (excludes plugin-specific options)
 */
export function convertDebugLogsToApiOptions(debugLogs: string[]): DebugOptions | undefined {
    const apiOptions: DebugOptions = {};
    const debugLogsSet = new Set(debugLogs);

    // Iterate over enum values and build API options based on what's selected
    for (const [key, friendlyName] of Object.entries(DebugLogDisplayNames)) {
        if (debugLogsSet.has(friendlyName)) {
            const apiKey = mapDebugLogToApiOption(key as DebugLogOption);
            if (apiKey) {
                apiOptions[apiKey] = true;
            }
        }
    }

    // Removed debug log that was causing "[] {}" output
    return Object.keys(apiOptions).length > 0 ? apiOptions : undefined;
}

/**
 * Get only the API-relevant debug log options (excludes plugin-specific options)
 * Used to determine if reconnection is needed when debug options change
 */
export function getApiRelevantDebugLogs(debugLogs: string[]): string[] {
    return debugLogs.filter(log => {
        const option = log as DebugLogOption;
        const apiKey = mapDebugLogToApiOption(option);
        // Only include options that map to API keys (exclude plugin-specific options)
        return apiKey !== null;
    });
}

/**
 * User-friendly display names for debug log options
 */
export const DebugLogDisplayNames: Record<DebugLogOption, string> = {
    [DebugLogOption.DebugRtsp]: 'RTSP',
    [DebugLogOption.TraceRecordings]: 'Trace recordings',
    [DebugLogOption.TraceNativeStream]: 'Trace native stream',
    [DebugLogOption.TraceTalk]: 'Trace talk',
    [DebugLogOption.TraceEvents]: 'Trace events XML',
};

/**
 * Get debug log choices with user-friendly names
 * Returns array of strings in format "value=displayName" for Scrypted settings
 */
export function getDebugLogChoices(): string[] {
    return Object.values(DebugLogOption).map(option => {
        const displayName = DebugLogDisplayNames[option];
        return `${displayName}`;
    });
}

