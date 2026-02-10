// src/ha-api.js — Home Assistant MQTT Discovery + Webhook integration
const mqtt = require('mqtt');
const { app } = require('electron');

const APP_ID = 'electron_ha_desktop_companion';
const APP_NAME = 'Desktop Companion';
const APP_VERSION = app.isPackaged
    ? app.getVersion()
    : require('../package.json').version;

// MQTT topic prefixes
const DISCOVERY_PREFIX = 'homeassistant';
const STATE_TOPIC = 'phill_pc_desktop/sensors';
const AVAILABILITY_TOPIC = 'phill_pc_desktop/status';

/** @type {import('mqtt').MqttClient|null} */
let mqttClient = null;

/** @type {boolean} */
let isConnected = false;

/** @type {function|null} */
let onConnectionChange = null;

/**
 * Set a callback for MQTT connection state changes.
 * @param {function} callback - (connected: boolean, message?: string) => void
 */
function setConnectionCallback(callback) {
    onConnectionChange = callback;
}

function emitConnection(connected, message) {
    isConnected = connected;
    if (onConnectionChange) {
        try { onConnectionChange(connected, message); } catch { /* ignore */ }
    }
}

/**
 * Connect to the MQTT broker.
 * @param {string} brokerUrl - e.g. "mqtt://192.168.178.22:1883"
 * @param {object} [options] - { username, password }
 * @returns {Promise<boolean>} true if connected
 */
function connect(brokerUrl, options = {}) {
    return new Promise((resolve, reject) => {
        if (mqttClient) {
            disconnect();
        }

        console.log(`[ha-api] Connecting to MQTT broker: ${brokerUrl}`);

        const connectOptions = {
            clientId: `phill_pc_desktop_${Date.now()}`,
            clean: true,
            connectTimeout: 10000,
            reconnectPeriod: 5000,
            will: {
                topic: AVAILABILITY_TOPIC,
                payload: 'offline',
                retain: true,
                qos: 1,
            },
            ...options,
        };

        mqttClient = mqtt.connect(brokerUrl, connectOptions);

        let resolved = false;
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                reject(new Error('MQTT verbinding timeout (10s)'));
            }
        }, 12000);

        mqttClient.on('connect', () => {
            clearTimeout(timeout);
            console.log('[ha-api] MQTT connected');
            // Publish online status
            mqttClient.publish(AVAILABILITY_TOPIC, 'online', { retain: true, qos: 1 }, (err) => {
                if (err) console.error('[ha-api] Failed to publish online status:', err.message);
                else console.log('[ha-api] Published online status to', AVAILABILITY_TOPIC);
            });
            emitConnection(true, 'Verbonden met MQTT broker');
            if (!resolved) {
                resolved = true;
                resolve(true);
            }
        });

        mqttClient.on('error', (err) => {
            console.error('[ha-api] MQTT error:', err.message);
            emitConnection(false, `MQTT fout: ${err.message}`);
            if (!resolved) {
                clearTimeout(timeout);
                resolved = true;
                reject(err);
            }
        });

        mqttClient.on('reconnect', () => {
            console.log('[ha-api] MQTT reconnecting...');
            emitConnection(false, 'MQTT herverbinden...');
        });

        mqttClient.on('close', () => {
            emitConnection(false, 'MQTT verbinding gesloten');
        });

        mqttClient.on('offline', () => {
            emitConnection(false, 'MQTT offline');
        });
    });
}

/**
 * Disconnect from MQTT broker gracefully.
 */
function disconnect() {
    if (mqttClient) {
        try {
            mqttClient.publish(AVAILABILITY_TOPIC, 'offline', { retain: true, qos: 1 });
            mqttClient.end(false);
        } catch { /* ignore */ }
        mqttClient = null;
        isConnected = false;
    }
}

/**
 * Check if MQTT is currently connected.
 * @returns {boolean}
 */
function getIsConnected() {
    return isConnected && mqttClient && mqttClient.connected;
}

/**
 * Publish MQTT Discovery config for one sensor.
 * Creates a device + entity in HA via MQTT Discovery protocol.
 *
 * @param {object} sensorDef - Sensor definition object
 * @param {object} deviceInfo - { device_name, manufacturer, model, os_name, os_version }
 * @param {string} deviceId - Stable device identifier
 */
function publishDiscoveryConfig(sensorDef, deviceInfo, deviceId) {
    if (!mqttClient || !mqttClient.connected) {
        console.warn('[ha-api] Cannot publish discovery: not connected');
        return;
    }

    const isBinary = sensorDef.type === 'binary_sensor';
    const component = isBinary ? 'binary_sensor' : 'sensor';
    const topic = `${DISCOVERY_PREFIX}/${component}/phill_pc_desktop/${sensorDef.unique_id}/config`;

    const config = {
        name: sensorDef.name,
        unique_id: sensorDef.unique_id,
        object_id: sensorDef.unique_id,
        state_topic: STATE_TOPIC,
        value_template: `{{ value_json.${sensorDef.unique_id} }}`,
        availability: {
            topic: AVAILABILITY_TOPIC,
            payload_available: 'online',
            payload_not_available: 'offline',
        },
        device: {
            identifiers: [deviceId],
            name: deviceInfo.device_name,
            manufacturer: deviceInfo.manufacturer,
            model: deviceInfo.model,
            sw_version: `${deviceInfo.os_version}`,
        },
    };

    // Add optional fields
    if (sensorDef.device_class) config.device_class = sensorDef.device_class;
    if (sensorDef.unit_of_measurement) config.unit_of_measurement = sensorDef.unit_of_measurement;
    if (sensorDef.state_class) config.state_class = sensorDef.state_class;
    if (sensorDef.icon) config.icon = sensorDef.icon;

    // Binary sensors use on/off payload mapping
    if (isBinary) {
        config.payload_on = 'true';
        config.payload_off = 'false';
    }

    mqttClient.publish(topic, JSON.stringify(config), { retain: true, qos: 1 }, (err) => {
        if (err) {
            console.error(`[ha-api] Discovery publish failed for ${sensorDef.unique_id}:`, err.message);
        }
    });
}

/**
 * Publish MQTT Discovery configs for ALL sensors.
 *
 * @param {Array} sensorDefs - Array of sensor definition objects
 * @param {object} deviceInfo - Device info from sensors.getDeviceInfo()
 * @param {string} deviceId - Stable device identifier
 * @returns {Promise<void>} Resolves when all configs are published
 */
function publishAllDiscoveryConfigs(sensorDefs, deviceInfo, deviceId) {
    return new Promise((resolve) => {
        if (!mqttClient || !mqttClient.connected) {
            console.warn('[ha-api] Cannot publish discovery: not connected');
            resolve();
            return;
        }

        // First, subscribe to discovery topics to find any stale retained configs
        // and clean them up before publishing new ones
        console.log(`[ha-api] Cleaning old discovery configs...`);
        const oldTopics = [];
        const discoveryPattern = `${DISCOVERY_PREFIX}/+/phill_pc_desktop/+/config`;

        const onMessage = (topic, msg) => {
            // If message is not empty and the unique_id is not in our current defs, wipe it
            if (msg.length > 0) {
                const parts = topic.split('/');
                const uniqueId = parts[3]; // homeassistant/<component>/phill_pc_desktop/<unique_id>/config
                const found = sensorDefs.some(d => d.unique_id === uniqueId);
                if (!found) {
                    oldTopics.push(topic);
                }
            }
        };

        mqttClient.subscribe(discoveryPattern, { qos: 1 }, () => {
            mqttClient.on('message', onMessage);

            // Wait a moment for retained messages to arrive, then clean up and publish
            setTimeout(() => {
                mqttClient.removeListener('message', onMessage);
                mqttClient.unsubscribe(discoveryPattern);

                // Wipe stale discovery configs
                for (const topic of oldTopics) {
                    mqttClient.publish(topic, '', { retain: true, qos: 1 });
                    console.log(`[ha-api] Removed stale discovery: ${topic}`);
                }

                // Now publish all current configs
                console.log(`[ha-api] Publishing ${sensorDefs.length} MQTT discovery configs...`);
                let count = 0;
                for (const def of sensorDefs) {
                    publishDiscoveryConfig(def, deviceInfo, deviceId);
                    count++;
                }

                setTimeout(() => {
                    console.log(`[ha-api] ${count} discovery configs published`);
                    resolve();
                }, 500);
            }, 1500);
        });
    });
}

/**
 * Publish all sensor states as a single JSON message.
 *
 * @param {Array} sensorStates - Array of { unique_id, state, attributes? } objects
 */
function publishSensorStates(sensorStates) {
    if (!mqttClient || !mqttClient.connected) {
        throw new Error('MQTT niet verbonden');
    }

    // Build a flat JSON object: { unique_id: state_value, ... }
    const payload = {};
    for (const s of sensorStates) {
        // Ensure state is a primitive (string/number/boolean), not an object.
        // For MQTT, null states become "None" (Jinja null) so HA shows "Unknown"
        // instead of "Unavailable" for numeric device_class sensors.
        const val = s.state;
        if (val === null || val === undefined) {
            payload[s.unique_id] = 'None';
        } else {
            payload[s.unique_id] = val;
        }
    }

    const json = JSON.stringify(payload);
    console.log(`[ha-api] Publishing to ${STATE_TOPIC} (${json.length} bytes, ${Object.keys(payload).length} sensors)`);

    mqttClient.publish(STATE_TOPIC, json, { retain: true, qos: 1 }, (err) => {
        if (err) {
            console.error('[ha-api] State publish FAILED:', err.message);
        }
    });
}

/**
 * Remove all MQTT Discovery configs (cleanup on uninstall).
 *
 * @param {Array} sensorDefs - Array of sensor definition objects
 */
function removeAllDiscoveryConfigs(sensorDefs) {
    if (!mqttClient || !mqttClient.connected) return;

    for (const def of sensorDefs) {
        const isBinary = def.type === 'binary_sensor';
        const component = isBinary ? 'binary_sensor' : 'sensor';
        const topic = `${DISCOVERY_PREFIX}/${component}/phill_pc_desktop/${def.unique_id}/config`;
        mqttClient.publish(topic, '', { retain: true, qos: 1 });
    }
    console.log('[ha-api] Discovery configs removed');
}

/**
 * Test connection to a Home Assistant instance (REST API check).
 *
 * @param {string} haUrl - Base URL
 * @param {string} token - Optional token to validate
 * @returns {{ reachable: boolean, authenticated: boolean }}
 */
async function testConnection(haUrl, token) {
    try {
        const response = await fetch(`${haUrl}/api/`, {
            method: 'GET',
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        });
        return {
            reachable: true,
            authenticated: response.ok,
            status: response.status,
        };
    } catch (error) {
        return {
            reachable: false,
            authenticated: false,
            error: error.message,
        };
    }
}

/**
 * Test MQTT broker reachability.
 *
 * @param {string} brokerUrl - e.g. "mqtt://192.168.178.22:1883"
 * @param {object} [options] - { username, password }
 * @returns {Promise<{ reachable: boolean, error?: string }>}
 */
function testMqttBroker(brokerUrl, options = {}) {
    return new Promise((resolve) => {
        const testClient = mqtt.connect(brokerUrl, {
            clientId: `test_${Date.now()}`,
            connectTimeout: 5000,
            reconnectPeriod: 0,
            ...options,
        });

        const timeout = setTimeout(() => {
            try { testClient.end(true); } catch { /* ignore */ }
            resolve({ reachable: false, error: 'Timeout (5s)' });
        }, 6000);

        testClient.on('connect', () => {
            clearTimeout(timeout);
            try { testClient.end(true); } catch { /* ignore */ }
            resolve({ reachable: true });
        });

        testClient.on('error', (err) => {
            clearTimeout(timeout);
            try { testClient.end(true); } catch { /* ignore */ }
            resolve({ reachable: false, error: err.message });
        });
    });
}

/**
 * Register this device with Home Assistant as a mobile_app integration.
 * Returns { webhook_id, ... } on success.
 */
async function registerDevice(haUrl, token, deviceInfo, deviceId) {
    const url = `${haUrl}/api/mobile_app/registrations`;
    const payload = {
        device_id: deviceId,
        app_id: APP_ID,
        app_name: APP_NAME,
        app_version: APP_VERSION,
        device_name: deviceInfo.device_name,
        manufacturer: deviceInfo.manufacturer,
        model: deviceInfo.model,
        os_name: deviceInfo.os_name,
        os_version: deviceInfo.os_version,
        supports_encryption: false,
        app_data: {},
    };

    console.log(`[ha-api] Registering device at ${url}...`);
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Device registration failed (${response.status}): ${text}`);
    }

    const result = await response.json();
    console.log('[ha-api] Device registered. Webhook ID:', result.webhook_id);
    return result;
}

/**
 * Register a single sensor via the webhook.
 */
async function registerSensor(webhookUrl, sensorDef, initialState) {
    const data = {};
    for (const [key, value] of Object.entries(sensorDef)) {
        if (!key.startsWith('_')) data[key] = value;
    }
    data.state = initialState ?? 'unknown';

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'register_sensor', data }),
    });

    if (!response.ok) {
        console.warn(`[ha-api] Sensor reg failed: ${sensorDef.unique_id} (${response.status})`);
        return false;
    }

    const status = response.status;
    let body = null;
    try { body = await response.json(); } catch { /* empty */ }

    if (status === 200 && (!body || !body.success)) {
        console.warn(`[ha-api] Sensor ${sensorDef.unique_id}: webhook may be stale`);
        return 'stale';
    }
    return true;
}

/**
 * Register all sensors in sequence via webhook.
 */
async function registerAllSensors(webhookUrl, sensorDefs, initialStates) {
    const stateMap = {};
    for (const s of initialStates) stateMap[s.unique_id] = s.state;

    let registered = 0, failed = 0, staleCount = 0;
    for (const def of sensorDefs) {
        try {
            const r = await registerSensor(webhookUrl, def, stateMap[def.unique_id]);
            if (r === true) registered++;
            else if (r === 'stale') staleCount++;
            else failed++;
        } catch (e) {
            console.error(`[ha-api] Sensor reg error ${def.unique_id}:`, e.message);
            failed++;
        }
    }
    console.log(`[ha-api] Sensor registration: ${registered} OK, ${failed} failed, ${staleCount} stale`);
    return { registered, failed, staleCount, isStale: staleCount > 0 && registered === 0 };
}

/**
 * Batch-update all sensor states via the HA webhook (REST API).
 */
async function updateSensorStates(webhookUrl, sensorStates) {
    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'update_sensor_states', data: sensorStates }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Sensor update failed (${response.status}): ${text}`);
    }
    try { return await response.json(); } catch { return {}; }
}

module.exports = {
    connect,
    disconnect,
    getIsConnected,
    publishDiscoveryConfig,
    publishAllDiscoveryConfigs,
    publishSensorStates,
    removeAllDiscoveryConfigs,
    registerDevice,
    registerSensor,
    registerAllSensors,
    updateSensorStates,
    testConnection,
    testMqttBroker,
    setConnectionCallback,
    AVAILABILITY_TOPIC,
    STATE_TOPIC,
};
