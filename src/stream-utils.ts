import type { ReolinkBaichuanApi, StreamProfile } from "@apocaliss92/reolink-baichuan-js" with { "resolution-mode": "import" };
import net from 'node:net';
import { URL } from 'node:url';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import {
    buildRfc4571Sdp,
    extractH264ParamSetsFromAccessUnit,
    extractH265ParamSetsFromAccessUnit,
    parseAdtsHeader,
    Rfc4571Muxer,
    type AudioConfig,
    type VideoParamSets,
} from './rfc4571-native';

export interface StreamManagerOptions {
    /**
     * Creates a dedicated Baichuan session for streaming.
     * Required to support concurrent main+ext streams on firmwares where streamType overlaps.
     */
    createStreamClient: () => Promise<ReolinkBaichuanApi>;
    getLogger: () => Console;
}

export function parseStreamProfileFromId(id: string | undefined): StreamProfile | undefined {
    if (!id)
        return;
    if (id === 'mainstream')
        return 'main';
    if (id === 'substream')
        return 'sub';
    if (id === 'extstream')
        return 'ext';

    // Back-compat with previous ids.
    if (id.startsWith('stream_')) {
        const profile = id.substring('stream_'.length);
        if (profile === 'main' || profile === 'sub' || profile === 'ext')
            return profile;
    }
    return;
}

export class StreamManager {
    private rtspServers = new Map<string, { rtspServer: any; rtspUrl: string }>();
    private rtspServerCreatePromises = new Map<string, Promise<{ rtspServer: any; rtspUrl: string }>>();
    private rfcServers = new Map<string, { server: net.Server; host: string; port: number; sdp: string; videoPayloadType: number; audioPayloadType?: number; rtspUrl: string }>();
    private rfcServerCreatePromises = new Map<string, Promise<{ host: string; port: number; sdp: string; videoPayloadType: number; audioPayloadType?: number }>>();
    private nativeRfcServers = new Map<string, {
        server: net.Server;
        host: string;
        port: number;
        sdp: string;
        videoType: 'H264' | 'H265';
        audio?: { codec: string; sampleRate: number; channels: number };
        videoStream: any;
        muxer: Rfc4571Muxer;
        audioFfmpeg?: ReturnType<typeof spawn>;
        audioUdp?: dgram.Socket;
    }>();
    private nativeRfcServerCreatePromises = new Map<string, Promise<{ host: string; port: number; sdp: string; audio?: { codec: string; sampleRate: number; channels: number } }>>();
    private loggedBaichuanLibInfo = false;

    constructor(private opts: StreamManagerOptions) {
    }

    private getLogger() {
        return this.opts.getLogger();
    }

    private async isRtspUrlListening(rtspUrl: string, timeoutMs = 750): Promise<boolean> {
        let url: URL;
        try {
            url = new URL(rtspUrl);
        }
        catch {
            return false;
        }

        const port = Number(url.port);
        const host = url.hostname;
        if (!host || !Number.isFinite(port) || port <= 0) {
            return false;
        }

        return await new Promise<boolean>((resolve) => {
            const socket = net.connect({ host, port });

            let settled = false;
            const finish = (result: boolean) => {
                if (settled) return;
                settled = true;
                try {
                    socket.removeAllListeners();
                    socket.end();
                    socket.destroy();
                }
                catch {
                    // ignore
                }
                resolve(result);
            };

            socket.setTimeout(timeoutMs);
            socket.once('connect', () => finish(true));
            socket.once('timeout', () => finish(false));
            socket.once('error', () => finish(false));
        });
    }

    private async ensureRtspServer(channel: number, profile: StreamProfile, streamKey: string): Promise<{ rtspServer: any; rtspUrl: string }> {
        const existingCreate = this.rtspServerCreatePromises.get(streamKey);
        if (existingCreate) {
            return existingCreate;
        }

        const createPromise = (async () => {
            const client = await this.opts.createStreamClient();
            const cached = this.rtspServers.get(streamKey);

            if (cached) {
                const isActive = typeof cached.rtspServer?.isActive === 'function'
                    ? !!cached.rtspServer.isActive()
                    : true;

                if (isActive && await this.isRtspUrlListening(cached.rtspUrl)) {
                    return cached;
                }

                // Stale/dead server: remove and attempt a best-effort stop.
                this.rtspServers.delete(streamKey);
                try {
                    if (typeof cached.rtspServer?.stop === 'function') {
                        await cached.rtspServer.stop();
                    }
                }
                catch (e) {
                    this.getLogger().warn(`Error stopping stale RTSP server for ${streamKey}`, e);
                }
            }

            // (Re)create RTSP server.
            // We intentionally create the RTSP server here (instead of api.createRtspStream)
            // so we can control TCP framing for broad client compatibility (e.g. ffmpeg expects
            // standard RTSP interleaved framing when using RTSP/TCP).
            const { BaichuanRtspServer } = await import('@apocaliss92/reolink-baichuan-js');
            const rtspServer = new BaichuanRtspServer({
                api: client,
                channel,
                profile,
                listenHost: '127.0.0.1',
                listenPort: 0,
                path: `/${streamKey}`,
                logger: this.getLogger(),
                tcpRtpFraming: 'rtsp-interleaved',
            });
            await rtspServer.start();

            const rtspUrl = rtspServer.getRtspUrl();
            const entry = { rtspServer, rtspUrl };
            this.rtspServers.set(streamKey, entry);

            const cleanupIfSame = () => {
                const current = this.rtspServers.get(streamKey);
                if (current?.rtspServer === rtspServer) {
                    this.rtspServers.delete(streamKey);
                }
            };

            // Ensure cache doesn't hold onto a closed/errored server.
            if (typeof rtspServer?.once === 'function') {
                rtspServer.once('close', cleanupIfSame);
                rtspServer.once('error', (e: any) => {
                    this.getLogger().error(`RTSP server error for ${streamKey}`, e);
                    cleanupIfSame();
                });
            }

            return entry;
        })();

        this.rtspServerCreatePromises.set(streamKey, createPromise);
        try {
            return await createPromise;
        }
        finally {
            this.rtspServerCreatePromises.delete(streamKey);
        }
    }

    private async rtspDescribe(rtspUrl: string, timeoutMs = 2000): Promise<string> {
        const u = new URL(rtspUrl);
        const host = u.hostname;
        const port = Number(u.port || 554);
        if (!host || !Number.isFinite(port) || port <= 0)
            throw new Error(`Invalid RTSP url: ${rtspUrl}`);

        return await new Promise<string>((resolve, reject) => {
            const socket = net.connect({ host, port });
            socket.setTimeout(timeoutMs);

            let buffer = Buffer.alloc(0);
            let headersParsed = false;
            let contentLength = 0;
            let headerEndIndex = -1;

            const cleanup = () => {
                try {
                    socket.removeAllListeners();
                    socket.end();
                    socket.destroy();
                }
                catch {
                    // ignore
                }
            };

            socket.once('connect', () => {
                const req = [
                    `DESCRIBE ${rtspUrl} RTSP/1.0`,
                    `CSeq: 1`,
                    `Accept: application/sdp`,
                    ``,
                    ``,
                ].join('\r\n');
                socket.write(req);
            });

            socket.on('data', (data) => {
                buffer = Buffer.concat([buffer, data]);

                if (!headersParsed) {
                    headerEndIndex = buffer.indexOf('\r\n\r\n');
                    if (headerEndIndex === -1)
                        return;
                    headersParsed = true;

                    const headerText = buffer.subarray(0, headerEndIndex).toString('utf8');
                    const statusLine = headerText.split(/\r\n/)[0] || '';
                    if (!statusLine.includes('200')) {
                        cleanup();
                        reject(new Error(`RTSP DESCRIBE failed: ${statusLine}`));
                        return;
                    }

                    const match = headerText.match(/\r\nContent-Length:\s*(\d+)/i);
                    contentLength = match ? Number(match[1]) : 0;
                }

                if (!headersParsed)
                    return;

                const bodyStart = headerEndIndex + 4;
                const availableBody = buffer.length - bodyStart;
                if (contentLength && availableBody < contentLength)
                    return;

                const body = contentLength
                    ? buffer.subarray(bodyStart, bodyStart + contentLength)
                    : buffer.subarray(bodyStart);

                cleanup();
                resolve(body.toString('utf8'));
            });

            socket.once('timeout', () => {
                cleanup();
                reject(new Error('RTSP DESCRIBE timeout'));
            });
            socket.once('error', (e) => {
                cleanup();
                reject(e);
            });
        });
    }

    private extractVideoSdpInfo(sdp: string): { payloadType: number; codec: string; fmtp?: string } {
        const lines = sdp.split(/\r\n|\n/).map(l => l.trim()).filter(Boolean);
        const mVideo = lines.find(l => l.startsWith('m=video'));
        if (!mVideo)
            throw new Error('SDP missing m=video');

        const parts = mVideo.split(/\s+/);
        const payloadType = Number(parts[3]);
        if (!Number.isFinite(payloadType))
            throw new Error(`SDP invalid video payload type: ${mVideo}`);

        const rtpmap = lines.find(l => l.toLowerCase().startsWith(`a=rtpmap:${payloadType}`.toLowerCase()));
        if (!rtpmap)
            throw new Error(`SDP missing a=rtpmap:${payloadType}`);
        const rtpmapParts = rtpmap.split(/\s+/);
        const codecToken = rtpmapParts[1]?.split('/')[0];
        if (!codecToken)
            throw new Error(`SDP invalid rtpmap: ${rtpmap}`);

        const fmtpLine = lines.find(l => l.toLowerCase().startsWith(`a=fmtp:${payloadType}`.toLowerCase()));
        const fmtp = fmtpLine ? fmtpLine.substring(`a=fmtp:${payloadType}`.length).trim() : undefined;

        return {
            payloadType,
            codec: codecToken,
            fmtp,
        };
    }

    private extractAudioSdpInfo(sdp: string): { payloadType: number; codec: string; sampleRate?: number; channels?: number; fmtp?: string } | undefined {
        const lines = sdp.split(/\r\n|\n/).map(l => l.trim()).filter(Boolean);
        const mAudio = lines.find(l => l.startsWith('m=audio'));
        if (!mAudio)
            return;

        const parts = mAudio.split(/\s+/);
        const payloadType = Number(parts[3]);
        if (!Number.isFinite(payloadType))
            return;

        const rtpmap = lines.find(l => l.toLowerCase().startsWith(`a=rtpmap:${payloadType}`.toLowerCase()));
        if (!rtpmap)
            return;

        const rtpmapParts = rtpmap.split(/\s+/);
        const codecAndRest = rtpmapParts[1];
        if (!codecAndRest)
            return;

        const codecParts = codecAndRest.split('/');
        const codecToken = codecParts[0];
        const sampleRate = codecParts.length >= 2 ? Number(codecParts[1]) : undefined;
        const channels = codecParts.length >= 3 ? Number(codecParts[2]) : undefined;

        const fmtpLine = lines.find(l => l.toLowerCase().startsWith(`a=fmtp:${payloadType}`.toLowerCase()));
        const fmtp = fmtpLine ? fmtpLine.substring(`a=fmtp:${payloadType}`.length).trim() : undefined;

        return {
            payloadType,
            codec: codecToken,
            sampleRate: Number.isFinite(sampleRate as any) ? sampleRate : undefined,
            channels: Number.isFinite(channels as any) ? channels : undefined,
            fmtp,
        };
    }

    private mapAudioCodecForWyzeStyleSdp(codec: string): string {
        const c = (codec || '').toLowerCase();
        if (c === 'mpeg4-generic')
            return 'MP4A-LATM';
        if (c === 'pcmu')
            return 'PCMU';
        if (c === 'pcma')
            return 'PCMA';
        if (c === 'opus')
            return 'OPUS';
        return codec;
    }

    private buildWyzeStyleSdp(video: { payloadType: number; codec: string; fmtp?: string }, audio?: { payloadType: number; codec: string; sampleRate?: number; channels?: number; fmtp?: string }): string {
        let out = 'v=0\r\n';
        out += 'o=- 0 0 IN IP4 0.0.0.0\r\n';
        out += 's=No Name\r\n';
        out += 't=0 0\r\n';
        out += `m=video 0 RTP/AVP ${video.payloadType}\r\n`;
        out += 'c=IN IP4 0.0.0.0\r\n';
        out += `a=rtpmap:${video.payloadType} ${video.codec}/90000\r\n`;
        if (video.fmtp)
            out += `a=fmtp:${video.payloadType} ${video.fmtp}\r\n`;

        if (audio) {
            const audioCodec = this.mapAudioCodecForWyzeStyleSdp(audio.codec);
            const rate = audio.sampleRate || 8000;
            const ch = audio.channels || 1;
            out += `m=audio 0 RTP/AVP ${audio.payloadType}\r\n`;
            out += 'c=IN IP4 0.0.0.0\r\n';
            out += 'b=AS:128\r\n';
            out += `a=rtpmap:${audio.payloadType} ${audioCodec}/${rate}/${ch}\r\n`;
            if (audio.fmtp)
                out += `a=fmtp:${audio.payloadType} ${audio.fmtp}\r\n`;
        }
        return out;
    }

    private async ensureRfcServer(streamKey: string, rtspUrl: string, videoPayloadType: number, audioPayloadType: number | undefined, sdp: string): Promise<{ host: string; port: number }> {
        const existingCreate = this.rfcServerCreatePromises.get(streamKey);
        if (existingCreate) {
            const v = await existingCreate;
            return { host: v.host, port: v.port };
        }

        const createPromise = (async () => {
            const cached = this.rfcServers.get(streamKey);
            if (cached?.server?.listening) {
                cached.rtspUrl = rtspUrl;
                cached.videoPayloadType = videoPayloadType;
                cached.audioPayloadType = audioPayloadType;
                cached.sdp = sdp;
                return { host: cached.host, port: cached.port, sdp: cached.sdp, videoPayloadType: cached.videoPayloadType, audioPayloadType: cached.audioPayloadType };
            }

            if (cached) {
                try {
                    cached.server.close();
                }
                catch {
                    // ignore
                }
                this.rfcServers.delete(streamKey);
            }

            const host = '127.0.0.1';
            const server = net.createServer((socket) => {
                let udpSocketVideo: dgram.Socket | undefined;
                let udpSocketAudio: dgram.Socket | undefined;
                let ffmpegVideoProc: ReturnType<typeof spawn> | undefined;
                let ffmpegAudioProc: ReturnType<typeof spawn> | undefined;
                let closed = false;

                const cleanup = () => {
                    if (closed) return;
                    closed = true;

                    try {
                        udpSocketVideo?.removeAllListeners();
                        udpSocketVideo?.close();
                        udpSocketAudio?.removeAllListeners();
                        udpSocketAudio?.close();
                    }
                    catch {
                        // ignore
                    }

                    try {
                        if (ffmpegVideoProc && !ffmpegVideoProc.killed) {
                            ffmpegVideoProc.kill('SIGTERM');
                        }
                        if (ffmpegAudioProc && !ffmpegAudioProc.killed) {
                            ffmpegAudioProc.kill('SIGTERM');
                        }
                        setTimeout(() => {
                            setTimeout(() => {
                                try {
                                    if (ffmpegVideoProc && !ffmpegVideoProc.killed)
                                        ffmpegVideoProc.kill('SIGKILL');
                                    if (ffmpegAudioProc && !ffmpegAudioProc.killed)
                                        ffmpegAudioProc.kill('SIGKILL');
                                }
                                catch {
                                    // ignore
                                }
                            }, 1000);
                        }, 0);
                    }
                    catch {
                        // ignore
                    }

                    try {
                        socket.end();
                        socket.destroy();
                    }
                    catch {
                        // ignore
                    }
                };

                socket.on('error', cleanup);
                socket.on('close', cleanup);

                (async () => {
                    const current = this.rfcServers.get(streamKey);
                    const currentRtspUrl = current?.rtspUrl || rtspUrl;
                    const currentVideoPayloadType = current?.videoPayloadType ?? videoPayloadType;
                    const currentAudioPayloadType = current?.audioPayloadType ?? audioPayloadType;

                    // Video RTP -> UDP -> RFC4571 on TCP
                    udpSocketVideo = dgram.createSocket('udp4');
                    await new Promise<void>((resolve, reject) => {
                        udpSocketVideo!.once('listening', resolve);
                        udpSocketVideo!.once('error', reject);
                        udpSocketVideo!.bind(0, '127.0.0.1');
                    });
                    const addrV = udpSocketVideo.address();
                    const udpPortV = typeof addrV === 'object' ? addrV.port : 0;

                    udpSocketVideo.on('message', (msg) => {
                        if (closed || socket.destroyed || !socket.writable)
                            return;
                        const h = Buffer.alloc(2);
                        h.writeUInt16BE(msg.length & 0xffff, 0);
                        try {
                            socket.write(Buffer.concat([h, msg]));
                        }
                        catch {
                            cleanup();
                        }
                    });

                    const ffmpegArgsVideo = [
                        '-loglevel', 'error',
                        '-rtsp_transport', 'tcp',
                        '-i', currentRtspUrl,
                        '-map', '0:v:0',
                        '-an',
                        '-c:v', 'copy',
                        '-f', 'rtp',
                        '-payload_type', String(currentVideoPayloadType),
                        `rtp://127.0.0.1:${udpPortV}?pkt_size=64000`,
                    ];

                    ffmpegVideoProc = spawn('ffmpeg', ffmpegArgsVideo, {
                        stdio: ['ignore', 'ignore', 'pipe'],
                    });
                    ffmpegVideoProc.on('error', (e) => {
                        this.getLogger().error(`ffmpeg spawn error (video) for RFC stream ${streamKey}`, e);
                        cleanup();
                    });
                    ffmpegVideoProc.stderr?.on('data', (d) => {
                        const msg = d.toString().trim();
                        if (msg)
                            this.getLogger().warn(`ffmpeg RFC video ${streamKey}: ${msg}`);
                    });
                    ffmpegVideoProc.on('exit', () => {
                        cleanup();
                    });

                    // Optional audio
                    if (currentAudioPayloadType !== undefined) {
                        udpSocketAudio = dgram.createSocket('udp4');
                        await new Promise<void>((resolve, reject) => {
                            udpSocketAudio!.once('listening', resolve);
                            udpSocketAudio!.once('error', reject);
                            udpSocketAudio!.bind(0, '127.0.0.1');
                        });
                        const addrA = udpSocketAudio.address();
                        const udpPortA = typeof addrA === 'object' ? addrA.port : 0;

                        udpSocketAudio.on('message', (msg) => {
                            if (closed || socket.destroyed || !socket.writable)
                                return;
                            const h = Buffer.alloc(2);
                            h.writeUInt16BE(msg.length & 0xffff, 0);
                            try {
                                socket.write(Buffer.concat([h, msg]));
                            }
                            catch {
                                cleanup();
                            }
                        });

                        const ffmpegArgsAudio = [
                            '-loglevel', 'error',
                            '-rtsp_transport', 'tcp',
                            '-i', currentRtspUrl,
                            '-map', '0:a:0',
                            '-vn',
                            '-c:a', 'copy',
                            '-f', 'rtp',
                            '-payload_type', String(currentAudioPayloadType),
                            `rtp://127.0.0.1:${udpPortA}?pkt_size=64000`,
                        ];

                        ffmpegAudioProc = spawn('ffmpeg', ffmpegArgsAudio, {
                            stdio: ['ignore', 'ignore', 'pipe'],
                        });
                        ffmpegAudioProc.on('error', (e) => {
                            this.getLogger().error(`ffmpeg spawn error (audio) for RFC stream ${streamKey}`, e);
                            cleanup();
                        });
                        ffmpegAudioProc.stderr?.on('data', (d) => {
                            const msg = d.toString().trim();
                            if (msg)
                                this.getLogger().warn(`ffmpeg RFC audio ${streamKey}: ${msg}`);
                        });
                        ffmpegAudioProc.on('exit', () => {
                            cleanup();
                        });
                    }
                })().catch((e) => {
                    this.getLogger().error(`RFC stream setup failed for ${streamKey}`, e);
                    cleanup();
                });
            });

            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, host, () => resolve());
            });

            const address = server.address();
            const port = typeof address === 'object' ? address.port : 0;
            if (!port)
                throw new Error('Failed to bind RFC TCP server');

            const entry = { server, host, port, sdp, videoPayloadType, audioPayloadType, rtspUrl };
            this.rfcServers.set(streamKey, entry);

            server.once('close', () => {
                const current = this.rfcServers.get(streamKey);
                if (current?.server === server)
                    this.rfcServers.delete(streamKey);
            });

            return { host, port, sdp, videoPayloadType, audioPayloadType };
        })();

        this.rfcServerCreatePromises.set(streamKey, createPromise);
        try {
            const created = await createPromise;
            return { host: created.host, port: created.port };
        }
        finally {
            this.rfcServerCreatePromises.delete(streamKey);
        }
    }

    private async ensureNativeRfcServer(
        streamKey: string,
        channel: number,
        profile: StreamProfile,
        expectedVideoType?: 'H264' | 'H265',
    ): Promise<{ host: string; port: number; sdp: string; audio?: { codec: string; sampleRate: number; channels: number } }> {
        const existingCreate = this.nativeRfcServerCreatePromises.get(streamKey);
        if (existingCreate) {
            return await existingCreate;
        }

        const createPromise = (async () => {
            const cached = this.nativeRfcServers.get(streamKey);
            if (cached?.server?.listening) {
                if (expectedVideoType && cached.videoType !== expectedVideoType) {
                    this.getLogger().warn(
                        `Native RFC cache codec mismatch for ${streamKey}: cached=${cached.videoType} expected=${expectedVideoType}; recreating server.`,
                    );
                }
                else {
                    return { host: cached.host, port: cached.port, sdp: cached.sdp, audio: cached.audio };
                }
            }

            if (cached) {
                try {
                    cached.muxer.close();
                    await cached.videoStream.stop();
                }
                catch {
                    // ignore
                }
                try {
                    await (cached as any).api?.close?.();
                }
                catch {
                    // ignore
                }
                try {
                    cached.server.close();
                }
                catch {
                    // ignore
                }
                this.nativeRfcServers.delete(streamKey);
            }

            const api = await this.opts.createStreamClient();
            const { BaichuanVideoStream } = await import('@apocaliss92/reolink-baichuan-js');
            if (!this.loggedBaichuanLibInfo) {
                this.loggedBaichuanLibInfo = true;
                try {
                    const lib: any = await import('@apocaliss92/reolink-baichuan-js');
                    const buildId = lib?.BAICHUAN_JS_BUILD_ID ?? 'MISSING_BUILD_ID_EXPORT';
                    const hasH265Depacketizer = typeof lib?.H265RtpDepacketizer === 'function';
                    this.getLogger().warn(`[reolink-baichuan-js] loaded buildId=${buildId} hasH265RtpDepacketizer=${hasH265Depacketizer}`);
                }
                catch (e) {
                    this.getLogger().warn(`[reolink-baichuan-js] failed to log buildId: ${e}`);
                }
            }
            const videoStream = new BaichuanVideoStream({
                client: api.client,
                api,
                channel,
                profile,
                logger: this.getLogger(),
            });

            const videoPayloadType = 96;
            const audioPayloadType = 97;

            await videoStream.start();

            const waitForKeyframe = async (): Promise<{ videoType: 'H264' | 'H265'; accessUnit: Buffer } & { profileLevelId?: string; h264?: { sps: Buffer; pps: Buffer }; h265?: { vps: Buffer; sps: Buffer; pps: Buffer } }> => {
                return await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        cleanup();
                        reject(new Error(`Timeout waiting for keyframe on native stream ${streamKey}`));
                    }, 5000);

                    const onError = (e: any) => {
                        cleanup();
                        reject(e instanceof Error ? e : new Error(String(e)));
                    };

                    const onAu = (au: any) => {
                        if (!au?.isKeyframe) return;
                        const videoType = au.videoType as 'H264' | 'H265';
                        const accessUnit = au.data as Buffer;

                        if (videoType === 'H264') {
                            const { sps, pps, profileLevelId } = extractH264ParamSetsFromAccessUnit(accessUnit);
                            if (!sps || !pps) return;
                            cleanup();
                            resolve({ videoType, accessUnit, profileLevelId, h264: { sps, pps } });
                            return;
                        }

                        const { vps, sps, pps } = extractH265ParamSetsFromAccessUnit(accessUnit);
                        if (!vps || !sps || !pps) return;
                        cleanup();
                        resolve({ videoType, accessUnit, h265: { vps, sps, pps } });
                    };

                    const cleanup = () => {
                        clearTimeout(timeout);
                        videoStream.removeListener('error' as any, onError as any);
                        videoStream.removeListener('videoAccessUnit' as any, onAu as any);
                    };

                    videoStream.on('error' as any, onError as any);
                    videoStream.on('videoAccessUnit' as any, onAu as any);
                });
            };

            const keyframe = await waitForKeyframe();

            // Best-effort framerate for raw elementary-stream input.
            let fps = 25;
            try {
                const metadata: any = await api.getStreamMetadata(channel);
                const streams: any[] = Array.isArray(metadata)
                    ? metadata
                    : Array.isArray(metadata?.streams) ? metadata.streams : [];
                const stream = streams.find((s: any) => s?.profile === profile);
                const fr = Number(stream?.frameRate);
                if (Number.isFinite(fr) && fr > 0) fps = fr;
            }
            catch {
                // ignore
            }

            let audio: { sampleRate: number; channels: number; configHex: string } | undefined;
            const tryPrimeAudio = async (): Promise<typeof audio> => {
                return await new Promise((resolve) => {
                    let sawAnyAudio = false;
                    let debugLogsLeft = 3;
                    const timeout = setTimeout(() => {
                        cleanup();
                        if (sawAnyAudio) {
                            this.getLogger().warn(`Native audio frames seen but not ADTS AAC for ${streamKey}; cannot advertise audio track.`);
                        }
                        resolve(undefined);
                    }, 5000);

                    const onAudio = (frame: Buffer) => {
                        sawAnyAudio = true;
                        const parsed = parseAdtsHeader(frame);
                        if (!parsed) {
                            if (debugLogsLeft-- > 0) {
                                const head = frame.subarray(0, Math.min(16, frame.length)).toString('hex');
                                this.getLogger().warn(`Native audioFrame not ADTS for ${streamKey}: len=${frame.length} head=${head}`);
                            }
                            return;
                        }
                        cleanup();
                        resolve({ sampleRate: parsed.sampleRate, channels: parsed.channels, configHex: parsed.configHex });
                    };

                    const cleanup = () => {
                        clearTimeout(timeout);
                        videoStream.removeListener('audioFrame' as any, onAudio as any);
                    };

                    videoStream.on('audioFrame' as any, onAudio as any);
                });
            };

            audio = await tryPrimeAudio();
            if (audio) {
                this.getLogger().log(`Native audio detected for ${streamKey}: AAC/ADTS ${audio.sampleRate}Hz ch=${audio.channels}`);
            }

            const video: VideoParamSets = {
                videoType: keyframe.videoType,
                payloadType: videoPayloadType,
                h264: keyframe.videoType === 'H264' ? {
                    sps: keyframe.h264!.sps,
                    pps: keyframe.h264!.pps,
                    profileLevelId: keyframe.profileLevelId,
                } : undefined,
                h265: keyframe.videoType === 'H265' ? {
                    vps: keyframe.h265!.vps,
                    sps: keyframe.h265!.sps,
                    pps: keyframe.h265!.pps,
                } : undefined,
            };

            // WebRTC expects Opus. AAC-in-RTP is not widely accepted by browsers.
            // Use ffmpeg to transcode ADTS AAC -> Opus RTP, then forward RTP packets via RFC4571.
            const opusAudio: AudioConfig | undefined = audio
                ? { codec: 'opus', payloadType: audioPayloadType, sampleRate: 48000, channels: 1 }
                : undefined;

            const sdp = buildRfc4571Sdp(video, opusAudio);

            const muxer = new Rfc4571Muxer(this.getLogger(), videoPayloadType, opusAudio ? audioPayloadType : undefined);

            let audioUdp: dgram.Socket | undefined;
            let audioFfmpeg: ReturnType<typeof spawn> | undefined;
            let loggedFirstOpus = false;

            const host = '127.0.0.1';
            let rfcClients = 0;
            let idleTeardownTimer: NodeJS.Timeout | undefined;
            let tearingDown = false;

            const scheduleIdleTeardown = () => {
                if (idleTeardownTimer) return;
                // Small delay to allow quick stream switches without churn.
                idleTeardownTimer = setTimeout(() => {
                    idleTeardownTimer = undefined;
                    if (rfcClients === 0) teardown(new Error('No RFC4571 clients (idle)')).catch(() => { });
                }, 2500);
            };

            const cancelIdleTeardown = () => {
                if (!idleTeardownTimer) return;
                clearTimeout(idleTeardownTimer);
                idleTeardownTimer = undefined;
            };
            const server = net.createServer((socket) => {
                rfcClients++;
                cancelIdleTeardown();
                if (rfcClients <= 3) {
                    this.getLogger().log(`Native RFC4571 client connected for ${streamKey}: ${socket.remoteAddress}:${socket.remotePort}`);
                }
                muxer.addClient(socket);

                let counted = true;
                const dec = () => {
                    if (!counted) return;
                    counted = false;
                    rfcClients = Math.max(0, rfcClients - 1);
                    if (rfcClients === 0) scheduleIdleTeardown();
                };
                socket.once('close', dec);
                socket.once('error', dec);
            });

            const teardown = async (reason?: any) => {
                if (tearingDown) return;
                tearingDown = true;

                cancelIdleTeardown();
                const message = reason?.message || reason?.toString?.() || reason;
                if (message)
                    this.getLogger().warn(`Native RFC server teardown for ${streamKey}: ${message}`);

                muxer.close();

                try {
                    audioUdp?.removeAllListeners();
                    audioUdp?.close();
                }
                catch {
                    // ignore
                }
                audioUdp = undefined;

                try {
                    audioFfmpeg?.stdin?.end();
                }
                catch {
                    // ignore
                }
                try {
                    audioFfmpeg?.kill('SIGKILL');
                }
                catch {
                    // ignore
                }
                audioFfmpeg = undefined;

                try {
                    await videoStream.stop();
                }
                catch {
                    // ignore
                }

                try {
                    await api.close();
                }
                catch {
                    // ignore
                }
                try {
                    server.close();
                }
                catch {
                    // ignore
                }
                const current = this.nativeRfcServers.get(streamKey);
                if (current?.server === server) this.nativeRfcServers.delete(streamKey);
            };

            // Video: use native access units -> our known-good RTP packetizer.
            videoStream.on('videoAccessUnit' as any, (au: any) => {
                try {
                    muxer.sendVideoAccessUnit(au.videoType, au.data, au.isKeyframe, au.microseconds);
                }
                catch (e) {
                    teardown(e);
                }
            });

            // Audio: if present, transcode AAC/ADTS -> Opus RTP with ffmpeg.
            if (opusAudio) {
                audioUdp = dgram.createSocket('udp4');
                await new Promise<void>((resolve, reject) => {
                    audioUdp!.once('error', reject);
                    audioUdp!.bind(0, '127.0.0.1', () => resolve());
                });

                const audioPort = (audioUdp.address() as any).port as number;
                audioUdp.on('message', (msg) => {
                    try {
                        if (!loggedFirstOpus && msg.length >= 12) {
                            loggedFirstOpus = true;
                            const pt = msg[1]! & 0x7f;
                            const seq = msg.readUInt16BE(2);
                            const ts = msg.readUInt32BE(4);
                            this.getLogger().log(`First Opus RTP for ${streamKey}: pt=${pt} seq=${seq} ts=${ts} bytes=${msg.length}`);
                        }
                        muxer.sendAudioRtpPacket(msg);
                    }
                    catch (e) {
                        teardown(e);
                    }
                });

                const ffmpegArgs = [
                    '-hide_banner',
                    '-loglevel', 'error',
                    '-analyzeduration', '0',
                    '-probesize', '512',
                    '-f', 'aac',
                    '-i', 'pipe:0',
                    '-acodec', 'libopus',
                    '-application', 'lowdelay',
                    '-ar', '48000',
                    '-ac', '1',
                    '-b:a', '32k',
                    '-payload_type', String(audioPayloadType),
                    '-f', 'rtp',
                    `rtp://127.0.0.1:${audioPort}?pkt_size=1200`,
                ];

                audioFfmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
                audioFfmpeg.stderr?.on('data', (d) => {
                    const msg = d.toString().trim();
                    if (msg) this.getLogger().warn(`ffmpeg opus audio ${streamKey}: ${msg}`);
                });
                audioFfmpeg.once('exit', () => {
                    teardown(new Error(`ffmpeg opus audio exited for ${streamKey}`));
                });

                let audioBackpressure = false;
                audioFfmpeg.stdin?.on('drain', () => {
                    audioBackpressure = false;
                });

                videoStream.on('audioFrame' as any, (frame: Buffer) => {
                    try {
                        if (!audioFfmpeg?.stdin?.writable) return;
                        if (audioBackpressure) return;
                        const ok = audioFfmpeg.stdin.write(frame);
                        if (!ok) audioBackpressure = true;
                    }
                    catch (e) {
                        teardown(e);
                    }
                });
            }

            videoStream.on('error' as any, teardown as any);
            videoStream.on('close' as any, teardown as any);

            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, host, () => resolve());
            });

            const address = server.address();
            const port = typeof address === 'object' ? address.port : 0;
            if (!port)
                throw new Error('Failed to bind native RFC TCP server');

            const audioInfo = opusAudio ? { codec: 'opus', sampleRate: opusAudio.sampleRate, channels: opusAudio.channels } : undefined;
            // Store the Baichuan API instance to close it on teardown/recreate.
            this.nativeRfcServers.set(streamKey, { server, host, port, sdp, videoType: keyframe.videoType, audio: audioInfo, videoStream, muxer, audioFfmpeg, audioUdp, api } as any);
            server.once('close', () => {
                const current = this.nativeRfcServers.get(streamKey);
                if (current?.server === server) this.nativeRfcServers.delete(streamKey);
            });

            return { host, port, sdp, audio: audioInfo };
        })();

        this.nativeRfcServerCreatePromises.set(streamKey, createPromise);
        try {
            return await createPromise;
        }
        finally {
            this.nativeRfcServerCreatePromises.delete(streamKey);
        }
    }

    async getRfcStream(
        channel: number,
        profile: StreamProfile,
        streamKey: string,
        expectedVideoType?: 'H264' | 'H265',
    ): Promise<{ host: string; port: number; sdp: string; audio?: { codec: string; sampleRate: number; channels: number } }> {
        return await this.ensureNativeRfcServer(streamKey, channel, profile, expectedVideoType);
    }
}
