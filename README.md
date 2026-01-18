# Reolink Native (TESTING PHASE)

This plugin aims to use reolink cameras with the only native API to allow a wider range of unsupported cameras + battery ones without hub.

##The plugin is still under testing due to the huge amount of possible devices available. If you have any issues with NVR report to me personally first or in the discord's Reolink channel to check if it's an issue with this plugin

The plugin will automatically distinguish between:
- Regular cameras
- Battery cameras
- NVRs

Battery cameras will be automatically set-up to disable prebuffer streams and snapshots (to preserve battery).
If the battery cams are not attached to an hub, it won't be possible to detect motino during the camera standby, this is due to the mechanism they use to communicate the pir events, which is through a subGhZ signal (which the the HOMEHUB is able to catch)

All the devices will be offered of RTSP and RTMP streams when available, and Native streams built upon the native reolink protocolos

Videoclips are available as opt-in with auto-download possibilites to fasten the loading. Since Reolink does nto store snapshots, scrypted will generate them when the clip is requested for the first time or on a schedule (settings available for that)

Multifocal cameras (such as Trackmix) will be provided with a combined stream in PIP-mode