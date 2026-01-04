import type { DebugOptions } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };

/**
 * User-friendly debug log options enum
 */
export enum DebugLogOption {
    /** General debug logs */
    General = 'general',
    /** RTSP proxy/server debug logs */
    DebugRtsp = 'debugRtsp',
    /** Stream command tracing */
    TraceStream = 'traceStream',
    /** Talkback tracing */
    TraceTalk = 'traceTalk',
    /** Event tracing */
    TraceEvents = 'traceEvents',
    /** H.264 debug logs */
    DebugH264 = 'debugH264',
    /** SPS/PPS parameter sets debug logs */
    DebugParamSets = 'debugParamSets',
    /** Event logs (plugin-specific, not passed to API) */
    EventLogs = 'eventLogs',
    /** Battery info logs (plugin-specific, not passed to API) */
    BatteryInfo = 'batteryInfo',
}

/**
 * Maps user-friendly enum values to API DebugOptions keys
 */
export function mapDebugLogToApiOption(option: DebugLogOption): keyof DebugOptions | null {
    const mapping: Record<DebugLogOption, keyof DebugOptions | null> = {
        [DebugLogOption.General]: 'general',
        [DebugLogOption.DebugRtsp]: 'debugRtsp',
        [DebugLogOption.TraceStream]: 'traceStream',
        [DebugLogOption.TraceTalk]: 'traceTalk',
        [DebugLogOption.TraceEvents]: 'traceEvents',
        [DebugLogOption.DebugH264]: 'debugH264',
        [DebugLogOption.DebugParamSets]: 'debugParamSets',
        [DebugLogOption.EventLogs]: null, // Plugin-specific, not passed to API
        [DebugLogOption.BatteryInfo]: null, // Plugin-specific, not passed to API
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
    [DebugLogOption.General]: 'General',
    [DebugLogOption.DebugRtsp]: 'RTSP',
    [DebugLogOption.TraceStream]: 'Trace stream',
    [DebugLogOption.TraceTalk]: 'Trace talk',
    [DebugLogOption.TraceEvents]: 'Trace events XML',
    [DebugLogOption.DebugH264]: 'H264',
    [DebugLogOption.DebugParamSets]: 'Video param sets',
    [DebugLogOption.EventLogs]: 'Object detection events',
    [DebugLogOption.BatteryInfo]: 'Battery info update',
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

