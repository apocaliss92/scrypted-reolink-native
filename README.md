# Reolink Native

This plugin aims to use reolink cameras with the only native API to allow a wider range of unsupported cameras + battery ones without hub.

**Documentation:** [https://advanced-notifier-docs.zentik.app/docs/reolink-native](https://advanced-notifier-docs.zentik.app/docs/reolink-native)

## Email Push (battery cameras)

Battery cameras (Argus, Go, …) can't keep a TCP push subscription alive while sleeping, so motion alerts get dropped. To work around this the plugin ships an **embedded SMTP intake** — the camera sends e-mail on motion and the plugin turns each delivery into the same `motionDetected` event you'd get from a wired camera.

### One-time server setup

1. Open the **Reolink E-mail Push Server** device that appears under the plugin provider. It's a singleton, created automatically the first time you open the plugin.
2. Random `nodelink-<hex>` username + base64url password are generated on first construction — they're shown in the **Auth** group of the Settings panel. Use **Regenerate random credentials** if you ever want to rotate them (re-run Auto-configure on every camera afterwards).
3. Defaults (`port=2525`, `bindHost=0.0.0.0`, `domain=nodelink.local`, `requireAuth=true`, `tls=false`) work out of the box on most LANs. Flip **Enabled** if you want the server to stay off.
4. The **Recommended camera-facing host** field shows the LAN IP the cameras should reach. If your Scrypted host has multiple interfaces and the wrong one is picked, set **Bind host** manually.

### Per-camera setup

You have two equivalent entry points — pick the one closer to where you already are:

- **From the server device** — open the *Auto-configure a camera* select in the **Actions** group, pick a camera, click Save. The select resets after each apply so it never silently re-runs. NVR-attached cameras are hidden (they share the NVR's mail path).
- **From the camera page** — open the camera's Settings, scroll to the **E-mail Push** group, and click **Auto-configure from Email Push Server**. Same effect, plus you can tweak **Trigger events** (`MD`/`people`/`vehicle`, default all three) and **Attachment** (`picture`/`video`/`none`, default `picture`) before applying.

What Auto-configure writes to the camera:

- SMTP server / port / `AUTH PLAIN` username + password from the server device
- Recipient `cam-<nativeId>@<domain>` (the plugin's per-camera intake address)
- Sender nickname = camera name
- 24/7 trigger schedule for the selected event types (existing schedule slots for other types are left untouched)

### Verifying delivery

- **Send test e-mail** (camera Settings → E-mail Push) makes the camera perform a real SMTP send against its saved target. Result is logged in the device console and reflected in the **Camera-side SMTP target** status row.
- **Refresh status** reads back the camera's own config (cmd 42) and renders it as `Target: host:port · Recipient: cam-<id>@<domain> · refreshed <ts>`. Reading wakes battery cameras so it's never automatic.
- **Last received** (server device → *Recent e-mails*) shows the last 20 deliveries with timestamp + inferred type + subject. In-memory ring, cleared on restart.

### Notes

- NVR-attached cameras don't get the E-mail Push settings group — the NVR handles mail centrally. Same for multifocal lens children.
- Recipients `cam-<unknown>@<domain>` are rejected with SMTP 550 — useful if you regenerate credentials or move a camera between Scrypted hosts.
- The intake is plain TCP; enable **STARTTLS** in the TLS group if you have `cert.pem`/`key.pem` in the configured TLS directory.

[For requests and bugs](https://github.com/apocaliss92/scrypted-reolink-native)

☕️ If this extension works well for you, consider buying me a coffee. Thanks!
[Buy me a coffee!](https://buymeacoffee.com/apocaliss92)
