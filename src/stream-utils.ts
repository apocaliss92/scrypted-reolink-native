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
    type AacAudioConfig,
    type VideoParamSets,
} from './rfc4571-native';

export interface StreamManagerOptions {
    ensureClient: () => Promise<ReolinkBaichuanApi>;
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
    private nativeRfcServers = new Map<string, { server: net.Server; host: string; port: number; sdp: string; videoStream: any; muxer: Rfc4571Muxer }>();
    private nativeRfcServerCreatePromises = new Map<string, Promise<{ host: string; port: number; sdp: string; audioSampleRate?: number }>>();

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
            const client = await this.opts.ensureClient();
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
            const rtspServer = await client.createRtspStream(channel, profile, {
                listenHost: '127.0.0.1',
                listenPort: 0,
                path: `/${streamKey}`,
            });

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

    private async ensureNativeRfcServer(streamKey: string, channel: number, profile: StreamProfile): Promise<{ host: string; port: number; sdp: string; audioSampleRate?: number }> {
        const existingCreate = this.nativeRfcServerCreatePromises.get(streamKey);
        if (existingCreate) {
            return await existingCreate;
        }

        const createPromise = (async () => {
            const cached = this.nativeRfcServers.get(streamKey);
            if (cached?.server?.listening) {
                return { host: cached.host, port: cached.port, sdp: cached.sdp };
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
                    cached.server.close();
                }
                catch {
                    // ignore
                }
                this.nativeRfcServers.delete(streamKey);
            }

            const api = await this.opts.ensureClient();
            const { BaichuanVideoStream } = await import('@apocaliss92/reolink-baichuan-js');
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

            let audio: AacAudioConfig | undefined;
            const tryPrimeAudio = async (): Promise<AacAudioConfig | undefined> => {
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
                        resolve({
                            payloadType: audioPayloadType,
                            sampleRate: parsed.sampleRate,
                            channels: parsed.channels,
                            configHex: parsed.configHex,
                        });
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

            const sdp = buildRfc4571Sdp(video, audio);

            const muxer = new Rfc4571Muxer(this.getLogger(), videoPayloadType, audio ? audioPayloadType : undefined);

            const host = '127.0.0.1';
            const server = net.createServer((socket) => muxer.addClient(socket));

            const teardown = async (reason?: any) => {
                const message = reason?.message || reason?.toString?.() || reason;
                if (message)
                    this.getLogger().warn(`Native RFC server teardown for ${streamKey}: ${message}`);

                muxer.close();
                try {
                    await videoStream.stop();
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

            videoStream.on('videoAccessUnit' as any, (au: any) => {
                try {
                    muxer.sendVideoAccessUnit(au.videoType, au.data, au.isKeyframe, au.microseconds);
                }
                catch (e) {
                    teardown(e);
                }
            });
            videoStream.on('audioFrame' as any, (frame: Buffer) => {
                try {
                    muxer.sendAudioAdtsFrame(frame);
                }
                catch (e) {
                    teardown(e);
                }
            });
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

            this.nativeRfcServers.set(streamKey, { server, host, port, sdp, videoStream, muxer });
            server.once('close', () => {
                const current = this.nativeRfcServers.get(streamKey);
                if (current?.server === server) this.nativeRfcServers.delete(streamKey);
            });

            return { host, port, sdp, audioSampleRate: audio?.sampleRate };
        })();

        this.nativeRfcServerCreatePromises.set(streamKey, createPromise);
        try {
            return await createPromise;
        }
        finally {
            this.nativeRfcServerCreatePromises.delete(streamKey);
        }
    }

    async getRfcStream(channel: number, profile: StreamProfile, streamKey: string): Promise<{ host: string; port: number; sdp: string; audioSampleRate?: number }> {
        try {
            return await this.ensureNativeRfcServer(streamKey, channel, profile);
        }
        catch (e) {
            this.getLogger().warn(`Native stream failed for ${streamKey}, falling back to RTSP+ffmpeg`, e);

            const { rtspUrl } = await this.ensureRtspServer(channel, profile, streamKey);
            const describedSdp = await this.rtspDescribe(rtspUrl);
            const videoInfo = this.extractVideoSdpInfo(describedSdp);
            const audioInfo = this.extractAudioSdpInfo(describedSdp);
            const sdp = this.buildWyzeStyleSdp(videoInfo, audioInfo);

            const { host, port } = await this.ensureRfcServer(streamKey, rtspUrl, videoInfo.payloadType, audioInfo?.payloadType, sdp);
            return { host, port, sdp, audioSampleRate: audioInfo?.sampleRate };
        }
    }
}
