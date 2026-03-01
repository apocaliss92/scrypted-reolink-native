# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Scrypted plugin for Reolink IP cameras using the proprietary Baichuan binary protocol (TCP port 9000 / UDP). Supports regular cameras, battery cameras, NVRs, and multifocal (dual-lens) cameras. The repo contains two components:

- **Plugin** (`src/`) — Scrypted DeviceProvider plugin, bundled by `scrypted-webpack`
- **Library** (`reolink-baichuan-js/`) — Baichuan protocol implementation, consumed as a local file dependency (`file:./reolink-baichuan-js`)

## Build Commands

### Plugin (root)
```bash
npm run build              # scrypted-webpack → dist/main.nodejs.js + dist/plugin.zip
npm run scrypted-deploy-debug  # build + deploy to debug Scrypted instance
```

### Library (reolink-baichuan-js/)
```bash
cd reolink-baichuan-js
npm run build              # tsup (ESM+CJS) + tsc declarations + api-extractor rollup
npm run typecheck           # tsc --noEmit
npm run lint               # eslint .
```

### Rebuild library and reinstall in plugin
```bash
./build-lib.sh             # builds library then runs npm install at root
```

After modifying `reolink-baichuan-js/`, always run `./build-lib.sh` from the root before building/deploying the plugin.

## Architecture

### Plugin Entry Point
`src/main.ts` — `ReolinkNativePlugin` is the root `DeviceProvider` and `DeviceCreator`. It manages device lifecycle and serves video clips/thumbnails via `HttpRequestHandler` webhooks.

### Device Hierarchy
- `BaseBaichuanClass` (`baichuan-base.ts`) — abstract base managing Baichuan API lifecycle (connection, reconnection with backoff, ping keepalive, event subscription)
- `ReolinkCamera` (`camera.ts`) — extends base, implements Scrypted interfaces (VideoCamera, Camera, Settings, ObjectDetector, PanTiltZoom, Intercom, etc.)
- `ReolinkNativeNvrDevice` (`nvr.ts`) — NVR support with DeviceDiscovery for channels
- `ReolinkNativeMultiFocalDevice` (`multiFocal.ts`) — dual-lens PIP stream support
- Accessories (`accessories/`) — sub-devices for siren, floodlight, PIR sensor, autotracking (separate ScryptedDeviceBase instances)

### Device Identification
Device type is encoded in the `nativeId` suffix: `-cam`, `-battery-cam`, `-nvr`, `-multifocal`, `-battery-multifocal`, `-udp-cam`, etc. The `createCamera()` factory in `main.ts` switches on these.

### Transport
TCP (regular cameras) or UDP/BCUDP (battery/WiFi cameras). Transport selection happens in `connect.ts` via `createBaichuanApi()`.

### API Lifecycle
The Baichuan API is lazily instantiated on first use via `ensureClientPromise` with automatic reconnection on disconnect.

## TypeScript Configuration

- **Plugin**: `module: Node16`, `target: ES2021`, no strict mode
- **Library**: `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `target: ES2022`, `moduleResolution: Bundler`

## Linting

Only the library has ESLint configured (flat config). `@typescript-eslint/no-explicit-any` is off. Unused vars prefixed with `_` are ignored.

## Debugging

VS Code launch config attaches to a Scrypted instance on port 10081 (configured via `scrypted.debugHost`). Pre-launch task runs `npm run scrypted-vscode-launch`.

## Key Local Dependencies

The plugin references sibling local repos via `file:` paths:
- `@scrypted/common` → `../../scrypted/common`
- `@scrypted/rtsp` → `../../scrypted/plugins/rtsp`

These must exist on disk for `npm install` to succeed.
