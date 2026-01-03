import type { PtzPreset } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import type { CommonCameraMixin } from "./common";

export type PtzCapabilitiesShape = {
    presets?: Record<string, string>;
    [key: string]: unknown;
};

export class ReolinkPtzPresets {
    constructor(private camera: CommonCameraMixin & { ptzCapabilities?: any }) { }

    private get storageSettings() {
        return this.camera.storageSettings;
    }

    private getPtzCapabilitiesStore(): PtzCapabilitiesShape | undefined {
        return this.camera.ptzCapabilities as PtzCapabilitiesShape | undefined;
    }

    private setPtzCapabilitiesStore(next: PtzCapabilitiesShape): void {
        this.camera.ptzCapabilities = next;
    }

    private parsePresetIdFromSettingValue(value: string): number | undefined {
        const s = String(value ?? '').trim();
        if (!s) return undefined;
        const idPart = s.includes('=') ? s.split('=')[0] : s;
        const id = Number(idPart);
        return Number.isFinite(id) ? id : undefined;
    }

    private syncEnabledPresetsSettingAndCaps(available: PtzPreset[]): void {
        const enabled = (this.storageSettings.values.presets ?? []) as string[];

        // If the user hasn't configured the "presets" setting, keep the auto-discovered preset list
        // (setCachedPtzPresets already applied it).
        if (!enabled.length) return;

        const nameById = new Map<number, string>(available.map((p) => [p.id, p.name]));

        // Apply only enabled presets mapping, but do NOT prune or rewrite the setting.
        // Prefer user-provided names ("id=name"), fallback to camera-provided name.
        const mapped: Record<string, string> = {};
        for (const entry of enabled) {
            const id = this.parsePresetIdFromSettingValue(entry);
            if (id === undefined) continue;

            const providedName = entry.includes('=')
                ? entry.substring(entry.indexOf('=') + 1).trim()
                : '';
            const name = providedName || nameById.get(id);
            if (!name) continue;

            mapped[String(id)] = name;
        }

        this.setPtzCapabilitiesStore({
            ...(this.getPtzCapabilitiesStore() ?? {}),
            presets: mapped,
        });
    }

    setCachedPtzPresets(presets: PtzPreset[] | undefined): void {
        const list = Array.isArray(presets) ? presets : [];
        this.camera.presets = list;

        const mapped: Record<string, string> = {};
        for (const p of list) {
            mapped[String(p.id)] = p.name;
        }

        this.setPtzCapabilitiesStore({
            ...(this.getPtzCapabilitiesStore() ?? {}),
            presets: mapped,
        });
    }

    getCachedPtzPresets(): PtzPreset[] {
        const v = this.camera.presets;
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
        const client = await this.camera.ensureClient();
        const channel = this.camera.storageSettings.values.rtspChannel;
        const presets = await client.getPtzPresets(channel);
        this.setCachedPtzPresets(presets);
        this.syncEnabledPresetsSettingAndCaps(presets);
        return presets;
    }

    async moveToPreset(presetId: number): Promise<void> {
        const client = await this.camera.ensureClient();
        const channel = this.camera.storageSettings.values.rtspChannel;
        await client.moveToPtzPreset(channel, presetId);
    }

    /** Create a new PTZ preset at current position. */
    async createPtzPreset(name: string, presetId?: number): Promise<PtzPreset> {
        const client = await this.camera.ensureClient();
        const channel = this.camera.storageSettings.values.rtspChannel;
        const trimmed = String(name ?? '').trim();
        if (!trimmed) throw new Error('Preset name is required');
        const existing = await client.getPtzPresets(channel);
        const existingIds = new Set(existing.map((p) => p.id));

        const id = presetId ?? this.nextFreePresetId(existing);
        if (presetId === undefined && existingIds.has(id)) {
            // Should not happen because nextFreePresetId returns unused id.
            throw new Error(`PTZ preset id already in use: ${id}`);
        }

        await client.setPtzPreset(channel, id, trimmed);

        const updated = await client.getPtzPresets(channel);
        const persisted = updated.some((p) => p.id === id);
        this.setCachedPtzPresets(updated);

        if (!persisted) {
            this.syncEnabledPresetsSettingAndCaps(updated);
            throw new Error(
                `PTZ preset save did not persist (camera returned an empty/unchanged preset list). Try again.`
            );
        }

        // If the "presets" setting is in use, auto-add the newly created preset so it becomes
        // immediately selectable/visible in the UI. If it's empty/unconfigured, don't start using it.
        const enabled = (this.storageSettings.values.presets ?? []) as string[];
        if (enabled.length) {
            const already = enabled.some((e) => this.parsePresetIdFromSettingValue(e) === id);
            if (!already) {
                enabled.push(`${id}=${trimmed}`);
                this.storageSettings.values.presets = enabled;
            }
        }

        // Re-apply enabled mapping (so custom names/filters remain effective after setCachedPtzPresets).
        this.syncEnabledPresetsSettingAndCaps(updated);
        return { id, name: trimmed };
    }

    /** Overwrite an existing preset with the current PTZ position (and keep its current name). */
    async updatePtzPresetToCurrentPosition(presetId: number): Promise<void> {
        const client = await this.camera.ensureClient();
        const channel = this.camera.storageSettings.values.rtspChannel;

        const current = this.getCachedPtzPresets();
        const found = current.find((p) => p.id === presetId);
        const name = found?.name ?? `Preset ${presetId}`;

        await client.setPtzPreset(channel, presetId, name);
        await this.refreshPtzPresets();
    }

    /** Best-effort delete/disable a preset (firmware dependent). */
    async deletePtzPreset(presetId: number): Promise<void> {
        const client = await this.camera.ensureClient();
        const channel = this.camera.storageSettings.values.rtspChannel;
        await client.deletePtzPreset(channel, presetId);

        // Keep enabled preset list clean (remove deleted id), but do not rewrite names for others.
        const enabledRaw = this.storageSettings.values.presets as unknown;
        if (Array.isArray(enabledRaw) && enabledRaw.length) {
            const filtered = (enabledRaw as unknown[])
                .filter((v) => typeof v === 'string')
                .filter((e) => this.parsePresetIdFromSettingValue(e as string) !== presetId) as string[];
            this.storageSettings.values.presets = filtered;
        }

        await this.refreshPtzPresets();
    }

    /** Rename a preset while trying to preserve its position (will move camera to that preset first). */
    async renamePtzPreset(presetId: number, newName: string): Promise<void> {
        const client = await this.camera.ensureClient();
        const channel = this.camera.storageSettings.values.rtspChannel;
        const trimmed = String(newName ?? '').trim();
        if (!trimmed) throw new Error('Preset name is required');

        // Warning: this moves the camera.
        await client.moveToPtzPreset(channel, presetId);
        await client.setPtzPreset(channel, presetId, trimmed);
        await this.refreshPtzPresets();
    }
}
