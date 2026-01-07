# Reolink Native - BETA

This plugin aims to use reolink cameras with the only native API to allow a wider range of unsupported cameras + battery ones without hub.

The plugin will automatically distinguish between:
- Regular cameras
- Battery cameras
- NVRs

Battery cameras will be automatically set-up to disable prebuffer streams and snapshots (to preserve battery).

All the devices will be offered of RTSP and RTMP streams when available, and Native streams built upon the native reolink protocolos

Videoclips are available as opt-in with auto-download possibilites to fasten the loading. Since Reolink does nto store snapshots, scrypted will generate them when the clip is requested for the first time or on a schedule (settings available for that)

Multifocal cameras (such as Trackmix) will be provided with a combined stream in PIP-mode

## Currently motion on standalone battery cams is not reliable, once the camera goes to sleep there is no known way (at least to me) to catch the motion events coming from PIR. The hub is able to get this informaion, will investigate further.