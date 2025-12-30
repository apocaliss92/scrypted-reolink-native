
import MqttClient from '../../scrypted-apocaliss-base/src/mqtt-client';

export const getMqttTopics = (cameraName: string) => {
    const statusTopic = `neolink/${cameraName}/status`;
    const batteryStatusTopic = `neolink/${cameraName}/status/battery_level`;
    const motionStatusTopic = `neolink/${cameraName}/status/motion`;
    const disconnecteStatusdTopic = `neolink/${cameraName}/status/disconnected`;
    const previewStatusTopic = `neolink/${cameraName}/status/preview`;
    const ptzPresetsStatusTopic = `neolink/${cameraName}/status/ptz/preset`;

    const batteryQueryTopic = `neolink/${cameraName}/query/battery`;
    const previewQueryTopic = `neolink/${cameraName}/query/preview`;
    const ptzPreviewQueryTopic = `neolink/${cameraName}/query/ptz/preset`;

    const ptzControlTopic = `neolink/${cameraName}/control/ptz`;
    const ptzPresetControlTopic = `neolink/${cameraName}/control/preset`;
    const floodlightControlTopic = `neolink/${cameraName}/control/floodlight`;
    const floodlightTasksControlTopic = `neolink/${cameraName}/control/floodlight_tasks`;
    const sirenControlTopic = `neolink/${cameraName}/control/siren`;
    const rebootControlTopic = `neolink/${cameraName}/control/reboot`;
    const ledControlTopic = `neolink/${cameraName}/control/led`;
    const irControlTopic = `neolink/${cameraName}/control/ir`;
    const pirControlTopic = `neolink/${cameraName}/control/pir`;

    return {
        statusTopic,
        batteryStatusTopic,
        motionStatusTopic,
        disconnecteStatusdTopic,
        ptzPresetsStatusTopic,
        previewStatusTopic,
        batteryQueryTopic,
        previewQueryTopic,
        ptzPreviewQueryTopic,
        ptzControlTopic,
        ptzPresetControlTopic,
        floodlightControlTopic,
        floodlightTasksControlTopic,
        sirenControlTopic,
        rebootControlTopic,
        ledControlTopic,
        irControlTopic,
        pirControlTopic,
    }
}

export const subscribeToNeolinkTopic = async (client: MqttClient, topic: string, console: Console, cb: (value?: any) => void) => {
    client.subscribe([topic], async (messageTopic, message) => {
        const messageString = message.toString();
        if (messageTopic === topic) {
            cb(messageString);
        }
    });

}

export const unsubscribeFromNeolinkTopic = async (client: MqttClient, topic: string, console: Console) => {
    client.unsubscribe([topic]);
}