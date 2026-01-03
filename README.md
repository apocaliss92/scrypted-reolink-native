# Reolink Native - BETA

This plugin aims to use reolink cameras with the only native API to allow a wider range of unsupported cameras + battery ones without hub.

The plugin will automatically distinguish between:
- Regular cameras
- Battery cameras
- NVRs

Battery cameras will be automatically set-up to disable prebuffer streams and snapshots (to preserve battery).

All the devices will be offered of RTSP and RTMP streams when available, and Native streams built upon the native reolink protocolos, these might be still unstable but with less latency

Missing features & Known bugs
- Motion is currently missing from standalone battery cameras, looking for a solution. There is the possibility to catch it as soon as it comes but it would mean to impact the battery because of the constant session
- Scrubbing with Native streams seems broken, working on a solution