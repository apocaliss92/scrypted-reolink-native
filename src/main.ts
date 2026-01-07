import sdk, { DeviceCreator, DeviceCreatorSettings, DeviceProvider, HttpRequest, HttpResponse, MediaObject, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, ScryptedNativeId, Setting, VideoClips } from "@scrypted/sdk";
import { BaseBaichuanClass } from "./baichuan-base";
import { ReolinkNativeCamera } from "./camera";
import { ReolinkNativeBatteryCamera } from "./camera-battery";
import { CommonCameraMixin } from "./common";
import { ReolinkNativeMultiFocalDevice } from "./multiFocal";
import { ReolinkNativeNvrDevice } from "./nvr";
import { batteryCameraSuffix, batteryMultifocalSuffix, cameraSuffix, extractThumbnailFromVideo, getDeviceInterfaces, handleVideoClipRequest, multifocalSuffix, nvrSuffix } from "./utils";

interface ThumbnailRequest {
    deviceId: string;
    fileId: string;
    rtmpUrl?: string;
    filePath?: string;
    logger: Console;
    resolve: (mo: MediaObject) => void;
    reject: (error: Error) => void;
}

interface ThumbnailRequestInput {
    deviceId: string;
    fileId: string;
    rtmpUrl?: string;
    filePath?: string;
    logger: Console;
}

class ReolinkNativePlugin extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
    devices = new Map<string, BaseBaichuanClass>();
    mixinsMap = new Map<string, CommonCameraMixin>();
    nvrDeviceId: string;
    private thumbnailQueue: ThumbnailRequest[] = [];
    private thumbnailProcessing = false;

    constructor(nativeId: string) {
        super(nativeId);

        const nvrDevice = sdk.systemManager.getDeviceByName('Scrypted NVR');
        this.nvrDeviceId = nvrDevice?.id;
    }

    getScryptedDeviceCreator(): string {
        return 'Reolink Native camera';
    }

    async getDevice(nativeId: ScryptedNativeId): Promise<BaseBaichuanClass> {
        if (this.devices.has(nativeId)) {
            return this.devices.get(nativeId)!;
        }

        const newCamera = this.createCamera(nativeId);
        this.devices.set(nativeId, newCamera);
        return newCamera;
    }

    async createDevice(settings: DeviceCreatorSettings, nativeId?: string): Promise<string> {
        const ipAddress = settings.ip?.toString();
        const username = settings.username?.toString();
        const password = settings.password?.toString();
        const uid = settings.uid?.toString();

        if (!ipAddress || !username || !password) {
            throw new Error('IP address, username, and password are required');
        }

        // Auto-detect device type (camera, battery-cam, or nvr)
        this.console.log(`[AutoDetect] Starting device type detection for ${ipAddress}...`);
        const { autoDetectDeviceType } = await import("@apocaliss92/reolink-baichuan-js");

        const detection = await autoDetectDeviceType(
            {
                host: ipAddress,
                username,
                password,
                uid,
                logger: this.console,
            },
        );

        this.console.log(`[AutoDetect] Detected device type: ${detection.type} (transport: ${detection.transport})`);

        // Use the API that was successfully used for detection
        const detectedApi = detection.api;

        // Handle multi-focal device case
        if (detection.type === 'multifocal') {
            const deviceInfo = detection.deviceInfo || {};
            const name = deviceInfo.name || 'Reolink Multi-Focal';
            const serialNumber = deviceInfo.serialNumber || deviceInfo.itemNo || `multifocal-${Date.now()}`;
            const isBattery = detection.transport === 'udp';
            nativeId = `${serialNumber}${isBattery ? batteryMultifocalSuffix : multifocalSuffix}`;

            settings.newCamera ||= name;

            const { capabilities, objects, presets } = await detectedApi.getDeviceCapabilities();

            const { interfaces } = getDeviceInterfaces({
                capabilities,
                logger: this.console,
            });

            await sdk.deviceManager.onDeviceDiscovered({
                nativeId,
                name,
                interfaces,
                type: ScryptedDeviceType.DeviceProvider,
                providerNativeId: this.nativeId,
            });

            const device = await this.getDevice(nativeId);
            if (!(device instanceof ReolinkNativeMultiFocalDevice)) {
                throw new Error('Expected multi-focal device but got different type');
            }
            device.classes = objects;
            device.presets = presets;
            device.storageSettings.values.ipAddress = ipAddress;
            device.storageSettings.values.username = username;
            device.storageSettings.values.password = password;
            device.storageSettings.values.uid = uid;
            device.storageSettings.values.capabilities = capabilities;

            return nativeId;
        }

        // Handle NVR case
        if (detection.type === 'nvr') {
            const deviceInfo = detection.deviceInfo || {};
            const name = deviceInfo?.name || 'Reolink NVR';
            const serialNumber = deviceInfo?.serialNumber || deviceInfo?.itemNo || `nvr-${Date.now()}`;
            nativeId = `${serialNumber}${nvrSuffix}`;

            settings.newCamera ||= name;

            await sdk.deviceManager.onDeviceDiscovered({
                nativeId,
                name,
                interfaces: [
                    ScryptedInterface.Settings,
                    ScryptedInterface.DeviceDiscovery,
                    ScryptedInterface.DeviceProvider,
                    ScryptedInterface.Reboot,
                ],
                type: ScryptedDeviceType.DeviceProvider,
                providerNativeId: this.nativeId,
            });

            const device = await this.getDevice(nativeId);
            if (!(device instanceof ReolinkNativeNvrDevice)) {
                throw new Error('Expected NVR device but got different type');
            }
            device.storageSettings.values.ipAddress = ipAddress;
            device.storageSettings.values.username = username;
            device.storageSettings.values.password = password;

            return nativeId;
        }

        // For camera and battery-cam, create the device
        const deviceInfo = detection.deviceInfo || {};
        const name = deviceInfo?.name || 'Reolink Camera';
        const serialNumber = deviceInfo?.serialNumber || deviceInfo?.itemNo || `unknown-${Date.now()}`;

        // Create nativeId based on device type
        if (detection.type === 'battery-cam') {
            nativeId = `${serialNumber}${batteryCameraSuffix}`;
        } else {
            nativeId = `${serialNumber}${cameraSuffix}`;
        }

        settings.newCamera ||= name;

        // Use the API that was successfully used for detection
        try {
            const rtspChannel = 0;
            const { capabilities, objects, presets } = await detectedApi.getDeviceCapabilities(rtspChannel);

            const { interfaces, type } = getDeviceInterfaces({
                capabilities,
                logger: this.console,
            });

            await sdk.deviceManager.onDeviceDiscovered({
                nativeId,
                name,
                interfaces,
                type,
                providerNativeId: this.nativeId,
            });

            const device = await this.getDevice(nativeId) as CommonCameraMixin;

            device.info = deviceInfo;
            device.classes = objects;
            device.presets = presets;
            device.storageSettings.values.username = username;
            device.storageSettings.values.password = password;
            device.storageSettings.values.rtspChannel = rtspChannel;
            device.storageSettings.values.ipAddress = ipAddress;
            device.storageSettings.values.capabilities = capabilities;
            device.storageSettings.values.uid = uid;

            return nativeId;
        }
        catch (e) {
            this.console.error('Error adding Reolink device', e);
            throw e;
        }
    }

    async releaseDevice(id: string, nativeId: ScryptedNativeId): Promise<void> {
        if (this.devices.has(nativeId)) {
            const device = this.devices.get(nativeId);
            if (device && 'release' in device && typeof device.release === 'function') {
                await device.release();
            }
            this.devices.delete(nativeId);
        }
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [
            {
                key: 'ip',
                title: 'IP Address',
                placeholder: '192.168.2.222',
                value: '192.168.',
            },
            {
                key: 'username',
                title: 'Username',
                value: 'admin',
            },
            {
                key: 'password',
                title: 'Password',
                type: 'password',
            },
            {
                key: 'uid',
                title: 'UID',
                description: 'Reolink UID (optional, required for battery cameras if TCP connection fails)',
            }
        ]
    }

    createCamera(nativeId: string) {
        if (nativeId.endsWith(batteryCameraSuffix)) {
            return new ReolinkNativeBatteryCamera(nativeId, this);
        } else if (nativeId.endsWith(nvrSuffix)) {
            return new ReolinkNativeNvrDevice(nativeId, this);
        } else if (nativeId.endsWith(batteryMultifocalSuffix)) {
            return new ReolinkNativeMultiFocalDevice(nativeId, this, "multi-focal-battery");
        } else if (nativeId.endsWith(multifocalSuffix)) {
            return new ReolinkNativeMultiFocalDevice(nativeId, this, "multi-focal");
        } else {
            return new ReolinkNativeCamera(nativeId, this);
        }
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const logger = this.console;
        const url = new URL(`http://localhost${request.url}`);
        
        try {
            // Parse webhook path: /.../webhook/{type}/{deviceId}/{fileId}
            // The path may include prefix like /endpoint/@apocaliss92/scrypted-reolink-native/public/webhook/...
            const pathParts = url.pathname.split('/').filter(p => p);
            
            // Find the index of 'webhook' in the path
            const webhookIndex = pathParts.indexOf('webhook');
            if (webhookIndex === -1 || pathParts.length < webhookIndex + 4) {
                response.send('Invalid webhook path', { code: 404 });
                return;
            }
            
            // Extract type, deviceId, and fileId after 'webhook'
            const type = pathParts[webhookIndex + 1];
            const encodedDeviceId = pathParts[webhookIndex + 2];
            // fileId may contain slashes, so join all remaining parts
            const encodedFileId = pathParts.slice(webhookIndex + 3).join('/');
            const deviceId = decodeURIComponent(encodedDeviceId);
            let fileId = decodeURIComponent(encodedFileId);
            
            // Restore leading slash if the original fileId had it (we removed it during encoding)
            // The API expects fileId with leading slash for absolute paths
            if (!fileId.startsWith('/') && !fileId.startsWith('http')) {
                // If it looks like an absolute path (starts with common path prefixes), add slash
                if (fileId.startsWith('mnt/') || fileId.startsWith('var/') || fileId.startsWith('tmp/')) {
                    fileId = `/${fileId}`;
                }
            }
            
            // logger.log(`Webhook request: type=${type}, deviceId=${deviceId}, fileId=${fileId}`);
            
            // Get the device
            const device = this.mixinsMap.get(deviceId); 
            if (!device) {
                response.send('Device not found', { code: 404 });
                return;
            }
            
            if (type === 'video') {
                await handleVideoClipRequest({
                    device,
                    deviceId,
                    fileId,
                    request,
                    response,
                    logger,
                });
                return;
            } else if (type === 'thumbnail') {
                // Get thumbnail MediaObject
                const mo = await device.getVideoClipThumbnail(fileId);
                
                // Convert to buffer
                const buffer = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
                
                // Send image
                response.send(buffer, {
                    code: 200,
                    headers: {
                        'Content-Type': 'image/jpeg',
                        'Cache-Control': 'max-age=31536000',
                    },
                });
                return;
            } else {
                response.send('Invalid webhook type', { code: 404 });
                return;
            }
        } catch (e: any) {
            logger.error('Error in onRequest', e);
            response.send(`Error: ${e.message}`, {
                code: 500,
            });
            return;
        }
    }

    onPush(request: HttpRequest): Promise<void> {
        return this.onRequest(request, undefined);
    }

    /**
     * Add a thumbnail generation request to the queue
     */
    async generateThumbnail(request: ThumbnailRequestInput): Promise<MediaObject> {
        const queueLength = this.thumbnailQueue.length;
        const isProcessing = this.thumbnailProcessing;
        request.logger.log(`[Thumbnail] Adding to queue: fileId=${request.fileId}, queueLength=${queueLength}, processing=${isProcessing}`);
        
        return new Promise((resolve, reject) => {
            this.thumbnailQueue.push({
                ...request,
                resolve,
                reject,
            });
            this.processThumbnailQueue();
        });
    }

    /**
     * Process the thumbnail queue sequentially
     */
    private async processThumbnailQueue(): Promise<void> {
        if (this.thumbnailProcessing || this.thumbnailQueue.length === 0) {
            return;
        }

        this.thumbnailProcessing = true;

        while (this.thumbnailQueue.length > 0) {
            const request = this.thumbnailQueue.shift()!;
            const logger = request.logger;
            
            try {
                const thumbnail = await this.extractThumbnailFromVideo(request);
                request.resolve(thumbnail);
            } catch (error) {
                logger.error(`[Thumbnail] Error: fileId=${request.fileId}`, error);
                request.reject(error instanceof Error ? error : new Error(String(error)));
            }
            
            // Add 2 second delay between thumbnails (except after the last one)
            if (this.thumbnailQueue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        this.thumbnailProcessing = false;
    }

    /**
     * Extract a thumbnail frame from video using ffmpeg
     */
    private async extractThumbnailFromVideo(request: ThumbnailRequest): Promise<MediaObject> {
        const { deviceId, fileId, rtmpUrl, filePath, logger } = request;
        return extractThumbnailFromVideo({
            rtmpUrl,
            filePath,
            fileId,
            deviceId,
            logger,
        });
    }
}

export default ReolinkNativePlugin;
