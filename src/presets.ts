import type { PtzPreset, ReolinkBaichuanApi } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };

export type PresetsStorage = {
    values: {
        cachedPresets: unknown;
    };
};

export type PtzCapabilitiesShape = {
    presets?: Record<string, string>;
    [key: string]: unknown;
};

export class ReolinkPtzPresets {
    constructor(private deps: {
        ensureClient: () => Promise<ReolinkBaichuanApi>;
        getRtspChannel: () => number;
        getLogger: () => { log: (...args: any[]) => void; warn: (...args: any[]) => void };
        storageSettings: PresetsStorage;
        getPtzCapabilities: () => PtzCapabilitiesShape | undefined;
        setPtzCapabilities: (next: PtzCapabilitiesShape) => void;
    }) {}

    setCachedPtzPresets(presets: PtzPreset[] | undefined): void {
        const list = Array.isArray(presets) ? presets : [];
        this.deps.storageSettings.values.cachedPresets = list as any;

        const mapped: Record<string, string> = {};
        for (const p of list) {
            mapped[String(p.id)] = p.name;
        }

        this.deps.setPtzCapabilities({
            ...(this.deps.getPtzCapabilities() ?? {}),
            presets: mapped,
        });
    }

    getCachedPtzPresets(): PtzPreset[] {
        const v = this.deps.storageSettings.values.cachedPresets as any;
        return Array.isArray(v) ? (v as PtzPreset[]) : [];
    }

    nextFreePresetId(existing: PtzPreset[]): number {
        const used = new Set(existing.map((p) => p.id));
        for (let id = 1; id <= 255; id++) {
            if (!used.has(id)) return id;
        }
        throw new Error('No free PTZ preset id available (1..255)');
    }

    async refreshPtzPresets(): Promise<PtzPreset[]> {
        const client = await this.deps.ensureClient();
        const channel = this.deps.getRtspChannel();
        const presets = await client.getPtzPresets(channel);
        this.setCachedPtzPresets(presets);
        return presets;
    }

    async moveToPreset(presetId: number): Promise<void> {
        const client = await this.deps.ensureClient();
        const channel = this.deps.getRtspChannel();
        await client.moveToPtzPreset(channel, presetId);
    }

    /** Create a new PTZ preset at current position. */
    async createPtzPreset(name: string, presetId?: number): Promise<PtzPreset> {
        const client = await this.deps.ensureClient();
        const channel = this.deps.getRtspChannel();
        const trimmed = String(name ?? '').trim();
        if (!trimmed) throw new Error('Preset name is required');

        const existing = await client.getPtzPresets(channel);
        const id = presetId ?? this.nextFreePresetId(existing);

        await client.setPtzPreset(channel, id, trimmed);
        const updated = await client.getPtzPresets(channel);
        this.setCachedPtzPresets(updated);
        return { id, name: trimmed };
    }

    /** Overwrite an existing preset with the current PTZ position (and keep its current name). */
    async updatePtzPresetToCurrentPosition(presetId: number): Promise<void> {
        const client = await this.deps.ensureClient();
        const channel = this.deps.getRtspChannel();

        const current = this.getCachedPtzPresets();
        const found = current.find((p) => p.id === presetId);
        const name = found?.name ?? `Preset ${presetId}`;

        await client.setPtzPreset(channel, presetId, name);
        await this.refreshPtzPresets();
    }

    /** Best-effort delete/disable a preset (firmware dependent). */
    async deletePtzPreset(presetId: number): Promise<void> {
        const client = await this.deps.ensureClient();
        const channel = this.deps.getRtspChannel();
        await client.deletePtzPreset(channel, presetId);
        await this.refreshPtzPresets();
    }

    /** Rename a preset while trying to preserve its position (will move camera to that preset first). */
    async renamePtzPreset(presetId: number, newName: string): Promise<void> {
        const client = await this.deps.ensureClient();
        const channel = this.deps.getRtspChannel();
        const trimmed = String(newName ?? '').trim();
        if (!trimmed) throw new Error('Preset name is required');

        // Warning: this moves the camera.
        await client.moveToPtzPreset(channel, presetId);
        await client.setPtzPreset(channel, presetId, trimmed);
        await this.refreshPtzPresets();
    }
}
