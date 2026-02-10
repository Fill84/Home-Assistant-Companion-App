// src/config.js — Configuration management for HA Companion (MQTT version)
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const configPath = path.join(app.getPath('userData'), 'ha-config.json');

const DEFAULT_CONFIG = {
    url: null,                // HA base URL (for webview)
    token: null,              // HA Long-Lived Access Token (for REST API checks)
    mqtt_broker: null,        // MQTT broker address, e.g. "192.168.178.22"
    mqtt_port: 1883,          // MQTT broker port
    mqtt_username: null,      // MQTT auth (optional)
    mqtt_password: null,      // MQTT auth (optional)
    device_id: null,          // Stable device identifier
    update_interval: 30,      // Sensor update interval in seconds
};

/**
 * Load configuration from disk.
 * Returns a merged object with defaults for any missing keys.
 */
function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
            const stored = JSON.parse(data);
            return { ...DEFAULT_CONFIG, ...stored };
        }
    } catch (e) {
        console.error('[config] Failed to read config:', e.message);
    }
    return { ...DEFAULT_CONFIG };
}

/**
 * Save configuration to disk.
 * @param {object} config — full or partial config object to merge and save
 */
function saveConfig(config) {
    try {
        const current = loadConfig();
        const merged = { ...current, ...config };
        fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8');
        return merged;
    } catch (e) {
        console.error('[config] Failed to save config:', e.message);
        return null;
    }
}

/**
 * Ensure the config has a stable device_id. Generate one if missing.
 */
function ensureDeviceId() {
    const config = loadConfig();
    if (!config.device_id) {
        config.device_id = `phill-pc-desktop-${crypto.randomUUID().slice(0, 8)}`;
        saveConfig(config);
    }
    return config.device_id;
}

/**
 * Build the MQTT broker URL from config.
 * @returns {string|null} e.g. "mqtt://192.168.178.22:1883"
 */
function getMqttBrokerUrl() {
    const config = loadConfig();
    if (!config.mqtt_broker) return null;
    return `mqtt://${config.mqtt_broker}:${config.mqtt_port || 1883}`;
}

/**
 * Get MQTT connection options (auth).
 * @returns {object} { username, password } or empty object
 */
function getMqttOptions() {
    const config = loadConfig();
    const opts = {};
    if (config.mqtt_username) opts.username = config.mqtt_username;
    if (config.mqtt_password) opts.password = config.mqtt_password;
    return opts;
}

/**
 * Check if the app is fully configured (has MQTT broker + HA URL).
 */
function isConfigured() {
    const config = loadConfig();
    return !!(config.mqtt_broker && config.url);
}

/**
 * Build the webhook URL from the stored config.
 * Priority: cloudhook_url > remote_ui_url > instance url
 * @returns {string|null}
 */
function getWebhookUrl() {
    const config = loadConfig();
    if (!config.webhook_id) return null;

    if (config.cloudhook_url) {
        return config.cloudhook_url;
    }
    if (config.remote_ui_url) {
        return `${config.remote_ui_url}/api/webhook/${config.webhook_id}`;
    }
    if (config.url) {
        return `${config.url}/api/webhook/${config.webhook_id}`;
    }
    return null;
}

/**
 * Reset companion configuration (keep url and token).
 */
function resetConfig() {
    const config = loadConfig();
    config.mqtt_broker = null;
    config.mqtt_port = 1883;
    config.mqtt_username = null;
    config.mqtt_password = null;
    saveConfig(config);
}

module.exports = {
    loadConfig,
    saveConfig,
    ensureDeviceId,
    getMqttBrokerUrl,
    getMqttOptions,
    getWebhookUrl,
    isConfigured,
    resetConfig,
    configPath,
};
