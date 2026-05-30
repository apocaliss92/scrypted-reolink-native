/**
 * Email Push Server — Scrypted singleton device exposing the manager-
 * side SMTP intake from `@apocaliss92/nodelink-js`.
 *
 * - Owns the lib's `createEmailPushServer` instance for this plugin
 *   process.
 * - Resolves incoming RCPT TO (`cam-<nativeId>@<domain>`) to a real
 *   Scrypted device (`ReolinkCamera`) by walking the plugin's
 *   `camerasMap`.
 * - Stores config + per-camera credentials in Scrypted's storage:
 *     - port, bindHost, domain, requireAuth, authUsername, authPassword,
 *       tls, tlsDir, maxMessageBytes, enabled
 *     - Random credentials are generated on first boot.
 * - Provides `Auto-configure all cameras` button: iterates every
 *   ReolinkCamera under the provider and pushes the manager-side SMTP
 *   settings via `api.setupEmailPushToManager` (lib auto-wraps the
 *   bare username in `<user@domain>` for the camera-side MAIL FROM).
 *
 * Per-camera event wiring lives in `camera.ts` — each ReolinkCamera
 * calls `api.subscribeEmailPushEvents({ cameraId: this.nativeId })`
 * once its api is ready, so the existing `api.onSimpleEvent` listener
 * that flips `motionDetected` true automatically handles both native
 * and SMTP-delivered events.
 */

import os from "node:os";
import { randomBytes } from "node:crypto";
import {
  ScryptedDeviceBase,
  ScryptedInterface,
  Setting,
  Settings,
  SettingValue,
} from "@scrypted/sdk";
// Type-only imports: the plugin builds against CommonJS while
// nodelink-js ships ESM. Values are loaded via dynamic import below.
import type {
  EmailPushServerConfig,
  EmailPushServerInstance,
} from "@apocaliss92/nodelink-js" with {
  "resolution-mode": "import",
};
import type ReolinkNativePlugin from "./main";

export const EMAIL_PUSH_SERVER_NATIVE_ID = "email-push-server";

const DEFAULT_PORT = 2525;
const DEFAULT_DOMAIN = "nodelink.local";
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

interface RecentMailRow {
  cameraId: string;
  recipient: string;
  inferredType: string;
  receivedAtMs: number;
  subject: string;
  from: string;
  bodyExcerpt: string;
}

export class EmailPushServerDevice
  extends ScryptedDeviceBase
  implements Settings
{
  plugin!: ReolinkNativePlugin;
  private instance: EmailPushServerInstance | undefined;

  constructor(nativeId: string) {
    super(nativeId);
    // Bootstrap missing credentials on first construction so the user
    // never sees blank/insecure defaults in Settings.
    if (!this.storage.getItem("authUsername")) {
      this.storage.setItem(
        "authUsername",
        `nodelink-${randomBytes(4).toString("hex")}`,
      );
    }
    if (!this.storage.getItem("authPassword")) {
      this.storage.setItem(
        "authPassword",
        randomBytes(18).toString("base64url"),
      );
    }
  }

  /** Called by the plugin on boot. Starts the SMTP intake if enabled. */
  async start(): Promise<void> {
    this.online = true;
    if (this.getEnabled()) {
      try {
        const inst = await this.ensureInstance();
        await inst.start();
      } catch (e) {
        this.console.error(
          `Email push server failed to start: ${e instanceof Error ? e.message : e}`,
        );
        this.online = false;
      }
    }
  }

  /** Called by the plugin on disposal. */
  async stop(): Promise<void> {
    if (this.instance) {
      await this.instance.stop().catch(() => {});
    }
    this.online = false;
  }

  private async ensureInstance(): Promise<EmailPushServerInstance> {
    if (this.instance) {
      this.instance.updateConfig(this.buildConfig());
      return this.instance;
    }
    const { createEmailPushServer } = await import("@apocaliss92/nodelink-js");
    this.instance = createEmailPushServer({
      config: this.buildConfig(),
      cameraResolver: (local) => this.resolveCameraId(local),
      logger: {
        debug: (m) => this.console.log(`[debug] ${m}`),
        info: (m) => this.console.log(m),
        warn: (m) => this.console.warn(m),
        error: (m) => this.console.error(m),
      },
    });
    return this.instance;
  }

  private buildConfig(): EmailPushServerConfig {
    return {
      port: Number(this.storage.getItem("port") || DEFAULT_PORT),
      bindHost: this.storage.getItem("bindHost") || "0.0.0.0",
      domain: this.storage.getItem("domain") || DEFAULT_DOMAIN,
      requireAuth: this.storage.getItem("requireAuth") !== "false",
      authUsername: this.storage.getItem("authUsername") || "",
      authPassword: this.storage.getItem("authPassword") || "",
      tls: this.storage.getItem("tls") === "true",
      tlsDir: this.storage.getItem("tlsDir") || "./email-push-tls",
      maxMessageBytes: Number(
        this.storage.getItem("maxMessageBytes") || DEFAULT_MAX_BYTES,
      ),
    };
  }

  private getEnabled(): boolean {
    return this.storage.getItem("enabled") !== "false";
  }

  /**
   * `camerasMap` is keyed by Scrypted's internal device UUID
   * (`cam.id`), NOT by `nativeId`. The e-mail pipeline however
   * identifies cameras by `nativeId` (recipient local-part = the
   * `cam-<nativeId>` we feed to `setupEmailPushToManager`), so any
   * lookup driven by an SMTP recipient or by a bus event needs to
   * walk the map's values and match on `cam.nativeId`.
   */
  private findCameraByNativeId(
    nativeId: string,
  ): ReolinkNativePlugin["camerasMap"] extends Map<string, infer C>
    ? C | undefined
    : never {
    for (const cam of this.plugin.camerasMap.values()) {
      if (cam.nativeId === nativeId) return cam as never;
    }
    return undefined as never;
  }

  /**
   * Match RCPT localpart (`cam-<nativeId>`) against the plugin's known
   * camera nativeIds. Returning the nativeId verbatim is what the lib
   * uses as the cameraId in the event payload; the per-camera
   * `subscribeEmailPushEvents({cameraId: this.nativeId})` filter in
   * camera.ts matches on equality.
   *
   * NVR-attached cameras are skipped — they don't have an independent
   * SMTP path (the NVR handles e-mail centrally), so accepting one
   * here would silently mis-route alerts. The Settings UI hides them
   * from the per-camera Auto-configure select for the same reason.
   */
  private resolveCameraId(local: string): string | undefined {
    const cam = this.findCameraByNativeId(local);
    if (!cam || cam.isOnNvr) return undefined;
    return local;
  }

  /**
   * Public accessor used by `ReolinkCamera` when the camera-side
   * Settings panel calls `Auto-configure from Email Push Server`.
   * Returns `null` when the server isn't yet configured (no LAN
   * address resolvable, missing storage) — the caller should surface
   * a user-friendly error instead of throwing.
   */
  public getManagerSetupParamsForCamera(props: {
    nativeId: string;
    id: string;
  }): {
    managerHost: string;
    managerPort: number;
    domain: string;
    recipientLocalPart: string;
    sendNickname: string;
    authUsername?: string;
    authPassword?: string;
  } | null {
    const { nativeId, id } = props;
    // Lookup by Scrypted device id — that's how `camerasMap` is keyed
    // (see `camera.ts:837 — camerasMap.set(this.id, this)`).
    const cam = this.plugin.camerasMap.get(id);
    if (!cam || cam.isOnNvr) return null;
    const cfg = this.buildConfig();
    const managerHost = this.listLanHosts()[0];
    if (!managerHost) return null;
    return {
      managerHost,
      managerPort: cfg.port,
      domain: cfg.domain,
      recipientLocalPart: nativeId,
      sendNickname: cam.name ?? nativeId,
      ...(cfg.requireAuth
        ? {
            authUsername: cfg.authUsername,
            authPassword: cfg.authPassword,
          }
        : {}),
    };
  }

  // ─── Settings ──────────────────────────────────────────────────

  async getSettings(): Promise<Setting[]> {
    const cfg = this.buildConfig();
    const status = this.instance?.getStatus();
    const candidates = this.listLanHosts();
    const recommendedHost = candidates[0] ?? "127.0.0.1";
    // Pull the latest from the in-memory ring before rendering.
    await this.refreshRecentEventsCache();

    return [
      {
        group: "Server",
        key: "enabled",
        title: "Enabled",
        description:
          "Start the SMTP intake on plugin load. When off the server is stopped and no e-mails are received.",
        type: "boolean",
        value: this.getEnabled(),
      },
      {
        group: "Server",
        key: "status",
        title: "Status",
        type: "string",
        readonly: true,
        value: status
          ? `${status.running ? "Running" : "Stopped"} on ${status.bindHost}:${status.port} (auth=${status.requireAuth}, tls=${status.tls}) — accepted=${status.messagesAccepted} rejected=${status.messagesRejected}`
          : "Not initialised",
      },
      {
        group: "Server",
        key: "managerHost",
        title: "Recommended camera-facing host",
        description:
          "Auto-detected LAN address of this Scrypted host. Use this value as the SMTP server on the camera side (or hit Auto-configure below).",
        type: "string",
        readonly: true,
        value: recommendedHost,
      },
      {
        group: "Server",
        key: "port",
        title: "Port",
        description: "Default 2525. Avoid privileged 25.",
        type: "number",
        value: cfg.port,
      },
      {
        group: "Server",
        key: "bindHost",
        title: "Bind host",
        description: "0.0.0.0 to listen on every interface.",
        type: "string",
        value: cfg.bindHost,
      },
      {
        group: "Server",
        key: "domain",
        title: "Virtual domain",
        description:
          "Used to extract the camera id from the recipient (cam-<id>@<domain>).",
        type: "string",
        value: cfg.domain,
      },
      {
        group: "Server",
        key: "maxMessageBytes",
        title: "Max message bytes",
        type: "number",
        value: cfg.maxMessageBytes,
      },
      {
        group: "Auth",
        key: "requireAuth",
        title: "Require AUTH",
        description:
          "Reolink firmwares are noticeably more reliable when AUTH PLAIN is negotiated. Recommended on.",
        type: "boolean",
        value: cfg.requireAuth,
      },
      {
        group: "Auth",
        key: "authUsername",
        title: "Auth username",
        description:
          "Bare value. The lib auto-wraps with @<domain> when configuring the camera so MAIL FROM stays RFC-compliant.",
        type: "string",
        value: cfg.authUsername,
      },
      {
        group: "Auth",
        key: "authPassword",
        title: "Auth password",
        type: "password",
        value: cfg.authPassword,
      },
      {
        group: "Auth",
        key: "regenerateAuth",
        title: "Regenerate random credentials",
        description:
          "Replaces the username + password with fresh random values. You'll need to re-run Auto-configure on the cameras after this.",
        type: "button",
      },
      {
        group: "TLS",
        key: "tls",
        title: "Enable STARTTLS",
        description:
          "Loads cert.pem + key.pem from the TLS directory. Disable if you don't have valid cert material.",
        type: "boolean",
        value: cfg.tls,
      },
      {
        group: "TLS",
        key: "tlsDir",
        title: "TLS directory",
        description: "Where the server looks for cert.pem and key.pem.",
        type: "string",
        value: cfg.tlsDir ?? "./email-push-tls",
      },
      {
        group: "Actions",
        key: "restart",
        title: "Restart server",
        description:
          "Stops and re-starts the SMTP intake with the latest settings.",
        type: "button",
      },
      {
        group: "Actions",
        key: "autoConfigureCamera",
        title: "Auto-configure a camera",
        description:
          "Pick a camera to push these server settings to (host, port, AUTH, recipient, 24/7 trigger schedule). Applies one camera at a time — pick again to configure the next. The selector resets after each apply so it never silently re-runs.",
        type: "string",
        // Force the empty value on every render so the select always
        // resets after an apply — Scrypted re-fetches settings on save.
        value: "",
        immediate: true,
        choices: ["", ...this.listCameraChoices()],
      },
      {
        group: "Recent e-mails (last 20, in-memory)",
        key: "recentEmails",
        title: "Last received",
        readonly: true,
        type: "string",
        value: this.recentEventsCache,
      },
    ];
  }

  async putSetting(key: string, value: SettingValue): Promise<void> {
    switch (key) {
      case "restart":
        try {
          const inst = await this.ensureInstance();
          await inst.restart();
        } catch (e) {
          this.console.error(
            `Restart failed: ${e instanceof Error ? e.message : e}`,
          );
        }
        break;
      case "autoConfigureCamera": {
        const targetNativeId = String(value ?? "").trim();
        if (!targetNativeId) break;
        await this.autoConfigureCamera(targetNativeId);
        // The select is rendered with `value: ""` on every getSettings,
        // so the next Settings refresh shows the empty placeholder again.
        break;
      }
      case "regenerateAuth":
        this.storage.setItem(
          "authUsername",
          `nodelink-${randomBytes(4).toString("hex")}`,
        );
        this.storage.setItem(
          "authPassword",
          randomBytes(18).toString("base64url"),
        );
        if (this.instance) await this.instance.restart().catch(() => {});
        break;
      case "enabled": {
        const enabled = value === true || value === "true";
        this.storage.setItem("enabled", String(enabled));
        if (enabled) {
          try {
            const inst = await this.ensureInstance();
            await inst.start();
          } catch (e) {
            this.console.error(
              `Start failed: ${e instanceof Error ? e.message : e}`,
            );
          }
        } else if (this.instance) {
          await this.instance.stop().catch(() => {});
        }
        break;
      }
      case "port":
      case "maxMessageBytes":
        this.storage.setItem(key, String(Number(value) || 0));
        if (this.instance) await this.instance.restart().catch(() => {});
        break;
      case "requireAuth":
      case "tls":
        this.storage.setItem(
          key,
          value === true || value === "true" ? "true" : "false",
        );
        if (this.instance) await this.instance.restart().catch(() => {});
        break;
      case "bindHost":
      case "domain":
      case "authUsername":
      case "authPassword":
      case "tlsDir":
        this.storage.setItem(key, String(value ?? ""));
        if (this.instance) await this.instance.restart().catch(() => {});
        break;
    }
    this.onDeviceEvent(ScryptedInterface.Settings, undefined);
  }

  /** Cached snapshot of the bus's recent events, refreshed on each Settings GET. */
  private recentEventsCache: string = "(loading…)";

  private async refreshRecentEventsCache(): Promise<void> {
    try {
      const { getRecentEmailPushEvents } =
        await import("@apocaliss92/nodelink-js");
      const events = getRecentEmailPushEvents(20);
      if (events.length === 0) {
        this.recentEventsCache = "No e-mails received yet.";
        return;
      }
      this.recentEventsCache = events
        .map((e: RecentMailRow) => {
          const ts = new Date(e.receivedAtMs).toISOString();
          // `e.cameraId` is the nativeId from the recipient local-part,
          // so we have to walk by nativeId to recover a friendly name.
          const name =
            this.findCameraByNativeId(e.cameraId)?.name ?? e.cameraId;
          return `${ts}  ${e.inferredType.padEnd(8)} ${name} — ${e.subject || "(no subject)"}`;
        })
        .join("\n");
    } catch (e) {
      this.recentEventsCache = `(error reading recent events: ${e instanceof Error ? e.message : e})`;
    }
  }

  /**
   * Build the dropdown options for the per-camera Auto-configure select.
   * Format: `"<nativeId>  —  <displayName>"` — `nativeId` is the
   * camera's plugin-side identifier (NOT the Scrypted UUID) so it
   * matches what the SMTP pipeline expects as the recipient local-part
   * and what `setupEmailPushToManager` writes back to the camera.
   */
  private listCameraChoices(): string[] {
    const out: string[] = [];
    for (const cam of this.plugin.camerasMap.values()) {
      // NVR-attached cameras don't have an independent SMTP path —
      // exclude them so users can't pick something that will silently
      // fail at delivery time.
      if (cam.isOnNvr) continue;
      if (!cam.nativeId) continue;
      const label = cam.name
        ? `${cam.nativeId}  —  ${cam.name}`
        : cam.nativeId;
      out.push(label);
    }
    return out.sort();
  }

  /**
   * Push the manager-side SMTP config to a single camera. The selector
   * value comes back as `"<nativeId>  —  <name>"`; we strip the label
   * suffix to recover the `nativeId`, then walk `camerasMap.values()`
   * to find the matching camera (the map is keyed by Scrypted UUID,
   * not nativeId — see `findCameraByNativeId`). The lib auto-wraps
   * `authUsername` in `<user@domain>` so the camera-side MAIL FROM is
   * RFC-compliant.
   */
  private async autoConfigureCamera(selection: string): Promise<void> {
    const nativeId = selection.split(/\s+—\s+/, 1)[0]?.trim();
    if (!nativeId) {
      this.console.warn(`Auto-configure: empty selection.`);
      return;
    }
    const cam = this.findCameraByNativeId(nativeId);
    if (!cam) {
      this.console.warn(
        `Auto-configure: camera not found for nativeId="${nativeId}".`,
      );
      return;
    }
    const cfg = this.buildConfig();
    const managerHost = this.listLanHosts()[0] ?? "127.0.0.1";
    this.console.log(
      `Auto-configuring ${cam.name ?? nativeId} against ${managerHost}:${cfg.port}`,
    );
    try {
      const api = await cam.ensureClient();
      await api.setupEmailPushToManager(
        {
          managerHost,
          managerPort: cfg.port,
          domain: cfg.domain,
          recipientLocalPart: nativeId,
          sendNickname: cam.name ?? nativeId,
          attachmentType: "picture",
          triggerTypes: ["MD", "people", "vehicle"],
          ...(cfg.requireAuth
            ? {
                authUsername: cfg.authUsername,
                authPassword: cfg.authPassword,
              }
            : {}),
          runTest: false,
        },
        cam.storageSettings?.values?.rtspChannel ?? 0,
      );
      this.console.log(`  ✓ ${cam.name ?? nativeId}`);
    } catch (e) {
      this.console.warn(
        `  ✗ ${cam.name ?? nativeId}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  private listLanHosts(): string[] {
    const ifaces = os.networkInterfaces();
    const candidates: { addr: string; rank: number }[] = [];
    for (const list of Object.values(ifaces)) {
      if (!list) continue;
      for (const addr of list) {
        if (addr.family !== "IPv4") continue;
        if (addr.internal) continue;
        if (addr.address.startsWith("169.254.")) continue;
        const rank = addr.address.startsWith("192.168.")
          ? 0
          : addr.address.startsWith("10.")
            ? 1
            : /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(addr.address)
              ? 2
              : 3;
        candidates.push({ addr: addr.address, rank });
      }
    }
    candidates.sort((a, b) => a.rank - b.rank);
    return candidates.map((c) => c.addr);
  }
}
