// src/sensor-loop.js — Periodic sensor data collection and publishing
const { loadConfig, getWebhookUrl } = require('./config');
const { collectSensorStates } = require('./sensors');
const { publishSensorStates, getIsConnected, updateSensorStates } = require('./ha-api');

let intervalHandle = null;
let isRunning = false;
let isUpdating = false;
let consecutiveErrors = 0;
let currentInterval = 30; // seconds

// Backoff schedule: 5s, 10s, 30s, 60s, 60s, ...
const BACKOFF_SCHEDULE = [5, 10, 30, 60];

/** @type {function|null} */
let onStatusChange = null;

/**
 * Set a callback for status changes.
 * @param {function} callback - (status: 'running'|'error'|'stopped', message?: string) => void
 */
function setStatusCallback(callback) {
    onStatusChange = callback;
}

function emitStatus(status, message) {
    if (onStatusChange) {
        try { onStatusChange(status, message); } catch { /* ignore */ }
    }
}

/**
 * Perform a single sensor update cycle.
 */
async function tick() {
    // Prevent concurrent ticks — avoids subprocess stacking
    if (isUpdating) {
        console.log('[sensor-loop] Previous tick still running, skipping');
        return;
    }
    isUpdating = true;

    try {
        const webhookUrl = getWebhookUrl();
        const mqttConnected = getIsConnected();

        if (!webhookUrl && !mqttConnected) {
            console.warn('[sensor-loop] No webhook URL and MQTT not connected, skipping update');
            emitStatus('error', 'Geen verbinding (webhook/MQTT)');
            return;
        }

        try {
            // Collect all sensor data
            const states = await collectSensorStates();

            if (states.length === 0) {
                console.warn('[sensor-loop] WARNING: collectSensorStates() returned EMPTY array!');
                emitStatus('error', 'Geen sensor data beschikbaar');
                return;
            }

            // 1. Push via webhook (primary — this is what actually updates entities in HA)
            if (webhookUrl) {
                try {
                    const result = await updateSensorStates(webhookUrl, states);
                    // Sample a few key dynamic sensors to verify values change
                    const cpu = states.find(s => s.unique_id === 'pc_cpu_usage');
                    const mem = states.find(s => s.unique_id === 'pc_mem_percent');
                    console.log(`[sensor-loop] Webhook OK: ${states.length} sensors | CPU=${cpu?.state}% MEM=${mem?.state}%`);
                } catch (whErr) {
                    console.error('[sensor-loop] Webhook FAILED:', whErr.message);
                }
            } else {
                console.warn('[sensor-loop] No webhook URL — HA entities will NOT update');
            }

            // 2. Also publish via MQTT (for MQTT-discovered entities)
            if (mqttConnected) {
                try {
                    publishSensorStates(states);
                } catch (mqttErr) {
                    console.error('[sensor-loop] MQTT publish failed:', mqttErr.message);
                }
            }

            // Reset error counter on success
            if (consecutiveErrors > 0) {
                console.log('[sensor-loop] Connection restored');
                emitStatus('running', 'Verbinding hersteld');
            }
            consecutiveErrors = 0;

        } catch (error) {
            consecutiveErrors++;
            const backoffIndex = Math.min(consecutiveErrors - 1, BACKOFF_SCHEDULE.length - 1);
            const backoffTime = BACKOFF_SCHEDULE[backoffIndex];

            console.error(
                `[sensor-loop] Update failed (attempt ${consecutiveErrors}):`,
                error.message,
                `| Next retry in ${backoffTime}s`
            );

            if (consecutiveErrors >= 3) {
                emitStatus('error', `Verbinding verloren (${consecutiveErrors} pogingen mislukt)`);
            }

            // Reschedule with backoff
            if (consecutiveErrors > 1 && intervalHandle) {
                clearInterval(intervalHandle);
                intervalHandle = setTimeout(() => {
                    tick().then(() => {
                        if (consecutiveErrors === 0 && isRunning) {
                            startInterval();
                        } else if (isRunning) {
                            const nextBackoff = BACKOFF_SCHEDULE[Math.min(consecutiveErrors - 1, BACKOFF_SCHEDULE.length - 1)];
                            intervalHandle = setTimeout(() => tick(), nextBackoff * 1000);
                        }
                    });
                }, backoffTime * 1000);
            }
        }
    } finally {
        isUpdating = false;
    }
}

/**
 * Start the regular interval.
 */
function startInterval() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        clearTimeout(intervalHandle);
    }
    const config = loadConfig();
    currentInterval = config.update_interval || 30;
    intervalHandle = setInterval(tick, currentInterval * 1000);
}

/**
 * Start the sensor update loop.
 * @param {number} [intervalSeconds] - Override interval from config
 */
function start(intervalSeconds) {
    if (isRunning) {
        console.log('[sensor-loop] Already running');
        return;
    }

    const config = loadConfig();
    currentInterval = intervalSeconds || config.update_interval || 30;
    isRunning = true;
    consecutiveErrors = 0;

    console.log(`[sensor-loop] Starting with ${currentInterval}s interval`);
    emitStatus('running', `Sensor updates elke ${currentInterval}s`);

    // Do an immediate first tick, then start interval
    tick().then(() => {
        if (isRunning) {
            startInterval();
        }
    });
}

/**
 * Stop the sensor update loop.
 */
function stop() {
    if (!isRunning) return;

    isRunning = false;
    if (intervalHandle) {
        clearInterval(intervalHandle);
        clearTimeout(intervalHandle);
        intervalHandle = null;
    }
    consecutiveErrors = 0;
    console.log('[sensor-loop] Stopped');
    emitStatus('stopped', 'Sensor updates gestopt');
}

/**
 * Change the update interval.
 * @param {number} seconds
 */
function setInterval_(seconds) {
    currentInterval = seconds;
    if (isRunning) {
        console.log(`[sensor-loop] Interval changed to ${seconds}s`);
        startInterval();
    }
}

/**
 * Get current loop status.
 */
function getStatus() {
    return {
        running: isRunning,
        interval: currentInterval,
        errors: consecutiveErrors,
        mqttConnected: getIsConnected(),
    };
}

module.exports = {
    start,
    stop,
    setInterval: setInterval_,
    getStatus,
    setStatusCallback,
    tick,
};
