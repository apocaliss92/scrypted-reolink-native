import net from 'node:net';
import crypto from 'node:crypto';

export type VideoType = 'H264' | 'H265';

export interface AacAudioConfig {
    payloadType: number;
    sampleRate: number;
    channels: number;
    configHex: string;
}

export interface VideoParamSets {
    videoType: VideoType;
    payloadType: number;
    h264?: {
        sps: Buffer;
        pps: Buffer;
        profileLevelId?: string;
    };
    h265?: {
        vps: Buffer;
        sps: Buffer;
        pps: Buffer;
    };
}

export function buildRfc4571Sdp(video: VideoParamSets, audio?: AacAudioConfig): string {
    let out = 'v=0\r\n';
    out += 'o=- 0 0 IN IP4 0.0.0.0\r\n';
    out += 's=No Name\r\n';
    out += 't=0 0\r\n';

    out += `m=video 0 RTP/AVP ${video.payloadType}\r\n`;
    out += 'c=IN IP4 0.0.0.0\r\n';
    out += `a=rtpmap:${video.payloadType} ${video.videoType}/90000\r\n`;

    if (video.videoType === 'H264' && video.h264) {
        const spsB64 = video.h264.sps.toString('base64');
        const ppsB64 = video.h264.pps.toString('base64');
        const pli = video.h264.profileLevelId ? `profile-level-id=${video.h264.profileLevelId};` : '';
        out += `a=fmtp:${video.payloadType} packetization-mode=1;${pli}sprop-parameter-sets=${spsB64},${ppsB64}\r\n`;
    }

    if (video.videoType === 'H265' && video.h265) {
        const vpsB64 = video.h265.vps.toString('base64');
        const spsB64 = video.h265.sps.toString('base64');
        const ppsB64 = video.h265.pps.toString('base64');
        out += `a=fmtp:${video.payloadType} sprop-vps=${vpsB64};sprop-sps=${spsB64};sprop-pps=${ppsB64}\r\n`;
    }

    if (audio) {
        out += `m=audio 0 RTP/AVP ${audio.payloadType}\r\n`;
        out += 'c=IN IP4 0.0.0.0\r\n';
        out += 'b=AS:128\r\n';
        out += `a=rtpmap:${audio.payloadType} MPEG4-GENERIC/${audio.sampleRate}/${audio.channels}\r\n`;
        out += `a=fmtp:${audio.payloadType} profile-level-id=1; mode=AAC-hbr; sizelength=13; indexlength=3; indexdeltalength=3; config=${audio.configHex}\r\n`;
    }

    return out;
}

export function splitAnnexBToNals(annexB: Buffer): Buffer[] {
    // Returns NAL units WITHOUT start codes.
    // Keep behavior aligned with reolink-baichuan-js (no aggressive trimming), since some payloads
    // may legitimately end with 0x00.
    const nals: Buffer[] = [];
    const len = annexB.length;

    const isStartCodeAt = (i: number): number => {
        if (i + 3 <= len && annexB[i] === 0x00 && annexB[i + 1] === 0x00) {
            if (annexB[i + 2] === 0x01) return 3;
            if (i + 4 <= len && annexB[i + 2] === 0x00 && annexB[i + 3] === 0x01) return 4;
        }
        return 0;
    };

    let i = 0;
    // find first start code
    while (i < len) {
        const sc = isStartCodeAt(i);
        if (sc) break;
        i++;
    }

    while (i < len) {
        const sc = isStartCodeAt(i);
        if (!sc) {
            i++;
            continue;
        }
        const nalStart = i + sc;
        let j = nalStart;
        while (j < len) {
            const sc2 = isStartCodeAt(j);
            if (sc2) break;
            j++;
        }
        if (nalStart < j) {
            const nal = annexB.subarray(nalStart, j);
            if (nal.length > 0) nals.push(nal);
        }
        i = j;
    }

    return nals;
}

function hasAnnexBStartCode(data: Buffer): boolean {
    if (!data?.length) return false;
    // Fast scan; access units are typically small.
    for (let i = 0; i + 3 < data.length; i++) {
        if (data[i] !== 0x00 || data[i + 1] !== 0x00) continue;
        if (data[i + 2] === 0x01) return true;
        if (data[i + 2] === 0x00 && data[i + 3] === 0x01) return true;
    }
    return false;
}

function stripLeadingAnnexBStartCode(data: Buffer): Buffer {
    if (data.length >= 4 && data[0] === 0x00 && data[1] === 0x00) {
        if (data[2] === 0x01) return data.subarray(3);
        if (data[2] === 0x00 && data[3] === 0x01) return data.subarray(4);
    }
    return data;
}

function splitLengthPrefixedToNalsAvcc(data: Buffer): Buffer[] {
    // AVCC/HVCC style: [u32be length][NAL bytes]...
    const nals: Buffer[] = [];
    let offset = 0;

    // Need at least one length + 1 byte payload.
    while (offset + 4 <= data.length) {
        const nalLen = data.readUInt32BE(offset);
        offset += 4;
        if (!nalLen) return [];
        if (offset + nalLen > data.length) return [];
        const nal = data.subarray(offset, offset + nalLen);
        offset += nalLen;
        if (nal.length) nals.push(nal);
    }

    // Must consume the buffer cleanly; otherwise treat as unknown format.
    if (offset !== data.length) return [];
    return nals;
}

function splitAccessUnitToNalsBestEffort(accessUnit: Buffer): Buffer[] {
    if (!accessUnit?.length) return [];

    if (hasAnnexBStartCode(accessUnit)) {
        const nals = splitAnnexBToNals(accessUnit);
        if (nals.length) return nals;
    }

    // If it looks like AVCC (often starts with 0x00 0x00 ..), try length-prefixed parsing.
    const avcc = splitLengthPrefixedToNalsAvcc(accessUnit);
    if (avcc.length) return avcc;

    // Single NAL without start code (or unknown packaging). Strip a leading start code if present.
    const stripped = stripLeadingAnnexBStartCode(accessUnit);
    return stripped.length ? [stripped] : [];
}

export function extractH264ParamSetsFromAccessUnit(annexB: Buffer): { sps?: Buffer; pps?: Buffer; profileLevelId?: string } {
    const nals = splitAccessUnitToNalsBestEffort(annexB);
    let sps: Buffer | undefined;
    let pps: Buffer | undefined;
    let profileLevelId: string | undefined;

    for (const nal of nals) {
        const nalType = nal[0] & 0x1f;
        if (nalType === 7) {
            sps = nal;
            if (nal.length >= 4) {
                const hex = Buffer.from([nal[1]!, nal[2]!, nal[3]!]).toString('hex');
                profileLevelId = hex;
            }
        }
        else if (nalType === 8) {
            pps = nal;
        }
    }

    return { sps, pps, profileLevelId };
}

export function extractH265ParamSetsFromAccessUnit(annexB: Buffer): { vps?: Buffer; sps?: Buffer; pps?: Buffer } {
    const nals = splitAccessUnitToNalsBestEffort(annexB);
    let vps: Buffer | undefined;
    let sps: Buffer | undefined;
    let pps: Buffer | undefined;

    for (const nal of nals) {
        if (nal.length < 2) continue;
        const nalType = (nal[0] >> 1) & 0x3f;
        if (nalType === 32) vps = nal;
        else if (nalType === 33) sps = nal;
        else if (nalType === 34) pps = nal;
    }

    return { vps, sps, pps };
}

const aacSampleRates = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
    16000, 12000, 11025, 8000, 7350,
];

export function parseAdtsHeader(adtsFrame: Buffer): { headerLength: number; sampleRate: number; channels: number; configHex: string } | null {
    if (adtsFrame.length < 7) return null;
    if (adtsFrame[0] !== 0xff || (adtsFrame[1] & 0xf0) !== 0xf0) return null;

    const protectionAbsent = (adtsFrame[1] & 0x01) === 1;
    const profile = (adtsFrame[2] & 0xc0) >> 6; // 0=Main,1=LC...
    const audioObjectType = profile + 1;
    const samplingFreqIndex = (adtsFrame[2] & 0x3c) >> 2;
    const sampleRate = aacSampleRates[samplingFreqIndex] ?? 0;
    const channels = ((adtsFrame[2] & 0x01) << 2) | ((adtsFrame[3] & 0xc0) >> 6);

    if (!sampleRate || !channels) return null;

    const headerLength = protectionAbsent ? 7 : 9;
    if (adtsFrame.length < headerLength) return null;

    // AudioSpecificConfig (2 bytes, left-aligned)
    const asc = ((audioObjectType & 0x1f) << 11) | ((samplingFreqIndex & 0x0f) << 7) | ((channels & 0x0f) << 3);
    const configHex = asc.toString(16).padStart(4, '0');

    return { headerLength, sampleRate, channels, configHex };
}

export interface RtpPacketizationOptions {
    maxRtpPayload: number;
}

class RtpWriter {
    private seq = 0;
    private timestamp = 0;
    private ssrc = crypto.randomBytes(4).readUInt32BE(0);

    constructor(private payloadType: number) {
        this.seq = crypto.randomBytes(2).readUInt16BE(0);
    }

    setTimestamp(ts: number) {
        this.timestamp = ts >>> 0;
    }

    getTimestamp(): number {
        return this.timestamp >>> 0;
    }

    advanceTimestamp(delta: number) {
        this.timestamp = (this.timestamp + (delta >>> 0)) >>> 0;
    }

    writePacket(payload: Buffer, marker: boolean): Buffer {
        const header = Buffer.alloc(12);
        header[0] = 0x80;
        header[1] = (marker ? 0x80 : 0x00) | (this.payloadType & 0x7f);
        header.writeUInt16BE(this.seq & 0xffff, 2);
        header.writeUInt32BE(this.timestamp >>> 0, 4);
        header.writeUInt32BE(this.ssrc >>> 0, 8);
        this.seq = (this.seq + 1) & 0xffff;
        return Buffer.concat([header, payload]);
    }
}

export function packetizeH264(nal: Buffer, rtp: RtpWriter, opts: RtpPacketizationOptions, markerOnLast: boolean, isLastNal: boolean): Buffer[] {
    const max = opts.maxRtpPayload;
    const out: Buffer[] = [];
    if (nal.length <= max) {
        out.push(rtp.writePacket(nal, markerOnLast && isLastNal));
        return out;
    }

    const nal0 = nal[0]!;
    const f = nal0 & 0x80;
    const nri = nal0 & 0x60;
    const type = nal0 & 0x1f;
    const fuIndicator = f | nri | 28;

    const data = nal.subarray(1);
    let offset = 0;
    while (offset < data.length) {
        const remaining = data.length - offset;
        const chunkLen = Math.min(remaining, max - 2);
        const start = offset === 0;
        const end = offset + chunkLen >= data.length;
        const fuHeader = (start ? 0x80 : 0x00) | (end ? 0x40 : 0x00) | (type & 0x1f);
        const payload = Buffer.concat([Buffer.from([fuIndicator, fuHeader]), data.subarray(offset, offset + chunkLen)]);
        out.push(rtp.writePacket(payload, markerOnLast && isLastNal && end));
        offset += chunkLen;
    }

    return out;
}

export function packetizeH265(nal: Buffer, rtp: RtpWriter, opts: RtpPacketizationOptions, markerOnLast: boolean, isLastNal: boolean): Buffer[] {
    const max = opts.maxRtpPayload;
    const out: Buffer[] = [];
    if (nal.length <= max) {
        out.push(rtp.writePacket(nal, markerOnLast && isLastNal));
        return out;
    }

    if (nal.length < 3) return out;

    const nalHeader0 = nal[0]!;
    const nalHeader1 = nal[1]!;
    const nalType = (nalHeader0 >> 1) & 0x3f;

    // FU indicator: F + type=49 + layerId/tid bits preserved.
    const fuIndicator0 = (nalHeader0 & 0x81) | (49 << 1);
    const fuIndicator1 = nalHeader1;

    const data = nal.subarray(2);
    let offset = 0;
    while (offset < data.length) {
        const remaining = data.length - offset;
        const chunkLen = Math.min(remaining, max - 3);
        const start = offset === 0;
        const end = offset + chunkLen >= data.length;
        const fuHeader = (start ? 0x80 : 0x00) | (end ? 0x40 : 0x00) | (nalType & 0x3f);
        const payload = Buffer.concat([
            Buffer.from([fuIndicator0, fuIndicator1, fuHeader]),
            data.subarray(offset, offset + chunkLen),
        ]);
        out.push(rtp.writePacket(payload, markerOnLast && isLastNal && end));
        offset += chunkLen;
    }

    return out;
}

export function packetizeAacAdtsFrame(adts: Buffer, rtp: RtpWriter): { packets: Buffer[]; config?: { sampleRate: number; channels: number; configHex: string } } {
    const parsed = parseAdtsHeader(adts);
    if (!parsed) return { packets: [] };
    const raw = adts.subarray(parsed.headerLength);
    if (!raw.length) return { packets: [] };

    // RFC 3640: AU-headers-length (16 bits) + AU-header (16 bits)
    const auHeadersLength = Buffer.from([0x00, 0x10]);
    const auSize = raw.length & 0x1fff;
    const auHeader = Buffer.alloc(2);
    auHeader[0] = (auSize >> 5) & 0xff;
    auHeader[1] = (auSize & 0x1f) << 3;

    const payload = Buffer.concat([auHeadersLength, auHeader, raw]);
    return {
        packets: [rtp.writePacket(payload, true)],
        config: { sampleRate: parsed.sampleRate, channels: parsed.channels, configHex: parsed.configHex },
    };
}

export interface Rfc4571Client {
    socket: net.Socket;
    needsKeyframe: boolean;
}

export class Rfc4571Muxer {
    private clients = new Set<Rfc4571Client>();
    private closed = false;

    private videoRtp: RtpWriter;
    private audioRtp: RtpWriter | undefined;

    // Timestamp tracking
    private videoBaseUs: number | undefined;
    private videoBaseTs: number | undefined;
    private videoLastTs: number | undefined;
    private readonly videoClockRate = 90000;
    private readonly fallbackVideoIncrement: number;

    constructor(
        private logger: Console,
        private videoPayloadType: number,
        audioPayloadType: number | undefined,
        videoFpsFallback = 25,
        private maxRtpPayload = 1200,
    ) {
        this.videoRtp = new RtpWriter(videoPayloadType);
        if (audioPayloadType !== undefined) {
            this.audioRtp = new RtpWriter(audioPayloadType);
        }
        this.fallbackVideoIncrement = Math.max(1, Math.round(this.videoClockRate / Math.max(1, videoFpsFallback)));
    }

    addClient(socket: net.Socket) {
        if (this.closed) {
            socket.destroy();
            return;
        }

        const client: Rfc4571Client = { socket, needsKeyframe: true };
        this.clients.add(client);

        const cleanup = () => {
            this.clients.delete(client);
            try {
                socket.destroy();
            } catch {
                // ignore
            }
        };

        socket.on('error', cleanup);
        socket.on('close', cleanup);
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        for (const c of Array.from(this.clients)) {
            try {
                c.socket.destroy();
            } catch {
                // ignore
            }
        }
        this.clients.clear();
    }

    private writeRtpPacketToClient(client: Rfc4571Client, pkt: Buffer) {
        if (client.socket.destroyed || !client.socket.writable) return;

        const header = Buffer.alloc(2);
        header.writeUInt16BE(pkt.length & 0xffff, 0);
        const framed = Buffer.concat([header, pkt]);

        try {
            client.socket.write(framed);
        }
        catch {
            try {
                client.socket.destroy();
            }
            catch {
                // ignore
            }
        }
    }

    private writeRtpPacketToClients(pkt: Buffer, predicate: (client: Rfc4571Client) => boolean) {
        for (const c of this.clients) {
            if (!predicate(c)) continue;
            this.writeRtpPacketToClient(c, pkt);
        }
    }

    setVideoTimestampFromMicroseconds(frameMicroseconds: number | null | undefined) {
        if (frameMicroseconds === null || frameMicroseconds === undefined) return;
        if (!Number.isFinite(frameMicroseconds)) return;

        if (this.videoBaseUs === undefined) {
            this.videoBaseUs = frameMicroseconds >>> 0;
            if (this.videoBaseTs === undefined) this.videoBaseTs = this.videoRtp.getTimestamp();
            this.videoLastTs = this.videoRtp.getTimestamp();
            return;
        }

        const baseUs = this.videoBaseUs >>> 0;
        const curUs = frameMicroseconds >>> 0;
        const deltaUs = (curUs - baseUs) >>> 0;
        const baseTs = (this.videoBaseTs ?? 0) >>> 0;
        let ts = (baseTs + Math.round((deltaUs * this.videoClockRate) / 1_000_000)) >>> 0;

        if (this.videoLastTs !== undefined && ts <= (this.videoLastTs >>> 0)) {
            ts = ((this.videoLastTs >>> 0) + 1) >>> 0;
        }

        this.videoRtp.setTimestamp(ts);
        this.videoLastTs = ts;
    }

    sendVideoAccessUnit(videoType: VideoType, accessUnitAnnexB: Buffer, isKeyframe: boolean, microseconds: number | null | undefined) {
        if (this.closed) return;

        // gate per-client until keyframe: do NOT stall existing synced clients.
        // If a new client connects (needsKeyframe=true), only that client will wait.
        const shouldSendTo = (c: Rfc4571Client) => isKeyframe ? true : !c.needsKeyframe;
        let hasAnyTarget = false;
        for (const c of this.clients) {
            if (shouldSendTo(c)) {
                hasAnyTarget = true;
                break;
            }
        }
        if (!hasAnyTarget) return;

        this.setVideoTimestampFromMicroseconds(microseconds);

        const nals = splitAccessUnitToNalsBestEffort(accessUnitAnnexB);
        if (!nals.length) return;

        const opts: RtpPacketizationOptions = { maxRtpPayload: this.maxRtpPayload };
        for (let i = 0; i < nals.length; i++) {
            const nal = nals[i]!;
            const isLastNal = i === nals.length - 1;
            const packets = videoType === 'H265'
                ? packetizeH265(nal, this.videoRtp, opts, true, isLastNal)
                : packetizeH264(nal, this.videoRtp, opts, true, isLastNal);

            for (const pkt of packets) this.writeRtpPacketToClients(pkt, shouldSendTo);
        }

        // if microseconds isn't usable, increment at a fixed fps.
        if (this.videoBaseUs === undefined) {
            this.videoRtp.advanceTimestamp(this.fallbackVideoIncrement);
        }

        // mark clients as started when the keyframe passes through
        if (isKeyframe) {
            for (const c of this.clients) c.needsKeyframe = false;
        }
    }

    sendAudioAdtsFrame(adts: Buffer): { parsed?: { sampleRate: number; channels: number; configHex: string } } {
        if (this.closed) return {};
        if (!this.audioRtp) return {};

        const { packets, config } = packetizeAacAdtsFrame(adts, this.audioRtp);
        // keep audio aligned with video gating: only send once video has started.
        for (const pkt of packets) this.writeRtpPacketToClients(pkt, c => !c.needsKeyframe);

        // advance by 1024 samples per AAC-LC frame
        if (packets.length) this.audioRtp.advanceTimestamp(1024);

        return { parsed: config };
    }
}
