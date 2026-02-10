// main.js — Electron HA Companion App (MQTT version)
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// Handle Squirrel installer events (create/remove shortcuts)
if (require('electron-squirrel-startup')) app.quit();

// src modules
const config = require('./src/config');
const haApi = require('./src/ha-api');
const sensors = require('./src/sensors');
const sensorLoop = require('./src/sensor-loop');
const tray = require('./src/tray');

// ============================================================
// Single instance lock — only one instance may run at a time
// ============================================================
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running — quit immediately
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to start a second instance — focus the existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

let mainWindow;

function createWindow() {
  const cfg = config.loadConfig();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });

  // Initialize system tray
  tray.initTray(mainWindow);
  tray.setOnSettingsClick(() => openSettings());

  if (cfg.url && cfg.mqtt_broker) {
    // Fully configured — load HA and start MQTT companion
    console.log('[main] Config found, loading:', cfg.url);
    mainWindow.loadURL(cfg.url);
    startCompanion();
  } else {
    // Not configured — show setup page
    console.log('[main] No config, loading setup.');
    mainWindow.loadFile('setup.html');
  }
}

/**
 * Start companion features:
 * 1. Register device with HA (webhook) if not already done
 * 2. Register sensors via webhook
 * 3. Connect to MQTT broker
 * 4. Publish MQTT Discovery configs for all sensors
 * 5. Start sensor update loop (uses webhook + MQTT)
 */
async function startCompanion() {
  const cfg = config.loadConfig();
  const brokerUrl = config.getMqttBrokerUrl();
  const mqttOptions = config.getMqttOptions();

  // 1. Ensure device is registered with HA (webhook)
  const deviceId = config.ensureDeviceId();
  const deviceInfo = await sensors.getDeviceInfo();
  const sensorDefs = await sensors.buildSensorDefinitions();
  const initialStates = await sensors.collectSensorStates();

  if (!cfg.webhook_id && cfg.url && cfg.token) {
    console.log('[main] No webhook_id found, registering device with HA...');
    try {
      const regResult = await haApi.registerDevice(cfg.url, cfg.token, deviceInfo, deviceId);
      if (regResult.webhook_id) {
        config.saveConfig({
          webhook_id: regResult.webhook_id,
          cloudhook_url: regResult.cloudhook_url || null,
          remote_ui_url: regResult.remote_ui_url || null,
        });
        console.log(`[main] Device registered, webhook_id: ${regResult.webhook_id}`);
      }
    } catch (e) {
      console.error('[main] Device registration failed:', e.message);
    }
  }

  // 2. Register sensors via webhook (if we have a webhook URL)
  const webhookUrl = config.getWebhookUrl();
  if (webhookUrl) {
    try {
      const regResult = await haApi.registerAllSensors(webhookUrl, sensorDefs, initialStates);
      console.log(`[main] Sensors registered via webhook: ${regResult.registered} OK`);

      if (regResult.isStale) {
        console.warn('[main] Webhook appears stale, re-registering device...');
        try {
          const newReg = await haApi.registerDevice(cfg.url, cfg.token, deviceInfo, deviceId);
          if (newReg.webhook_id) {
            config.saveConfig({
              webhook_id: newReg.webhook_id,
              cloudhook_url: newReg.cloudhook_url || null,
              remote_ui_url: newReg.remote_ui_url || null,
            });
            console.log(`[main] Re-registered, new webhook_id: ${newReg.webhook_id}`);
            // Re-register sensors with new webhook
            const newUrl = config.getWebhookUrl();
            if (newUrl) {
              await haApi.registerAllSensors(newUrl, sensorDefs, initialStates);
            }
          }
        } catch (reRegErr) {
          console.error('[main] Re-registration failed:', reRegErr.message);
        }
      }
    } catch (e) {
      console.error('[main] Sensor registration failed:', e.message);
    }
  } else {
    console.warn('[main] No webhook URL available, sensors will only update via MQTT');
  }

  // 3. Connect to MQTT (for discovery + supplementary state updates)
  if (brokerUrl) {
    try {
      await haApi.connect(brokerUrl, mqttOptions);
    } catch (e) {
      console.error('[main] MQTT connection failed:', e.message);
      tray.showBalloon('HA Companion', `MQTT fout: ${e.message}`);
    }

    // 4. Publish MQTT Discovery configs
    try {
      await haApi.publishAllDiscoveryConfigs(sensorDefs, deviceInfo, deviceId);
      console.log(`[main] Published ${sensorDefs.length} MQTT discovery configs`);
    } catch (e) {
      console.error('[main] Discovery publish failed:', e.message);
    }
  }

  // 5. Set status callback for tray notifications
  sensorLoop.setStatusCallback((status, message) => {
    if (status === 'error') {
      tray.showBalloon('HA Companion', message);
    }
  });

  // 6. Start sensor update loop
  sensorLoop.start(cfg.update_interval);
}

/**
 * Perform full setup: test HA + MQTT, save config, start companion.
 */
async function performSetup(url, token, mqttBroker, mqttPort, mqttUser, mqttPass, interval) {
  try {
    // Normalize URL
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'http://' + url;
    }
    if (url.endsWith('/')) url = url.slice(0, -1);

    // 1. Test HA connection
    console.log(`[main] Testing HA connection to ${url}...`);
    const connTest = await haApi.testConnection(url, token);
    if (!connTest.reachable) {
      throw new Error('HA server niet bereikbaar. Controleer het adres.');
    }
    if (!connTest.authenticated) {
      throw new Error(`Authenticatie mislukt (status ${connTest.status}). Controleer het token.`);
    }

    // 2. Test MQTT broker
    const brokerUrl = `mqtt://${mqttBroker}:${mqttPort || 1883}`;
    console.log(`[main] Testing MQTT broker at ${brokerUrl}...`);
    const mqttTest = await haApi.testMqttBroker(brokerUrl, {
      username: mqttUser || undefined,
      password: mqttPass || undefined,
    });
    if (!mqttTest.reachable) {
      throw new Error(`MQTT broker niet bereikbaar: ${mqttTest.error || 'Onbekende fout'}`);
    }

    // 3. Save config
    config.ensureDeviceId();
    config.saveConfig({
      url,
      token,
      mqtt_broker: mqttBroker,
      mqtt_port: parseInt(mqttPort, 10) || 1883,
      mqtt_username: mqttUser || null,
      mqtt_password: mqttPass || null,
      update_interval: interval,
    });

    return { success: true };
  } catch (error) {
    console.error('[main] Setup failed:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================================
// Settings
// ============================================================

function openSettings() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('show-settings');
}

// ============================================================
// IPC Handlers
// ============================================================

// Connect & register from setup page
ipcMain.handle('connect-to-ha', async (event, data) => {
  const { url, token, mqtt_broker, mqtt_port, mqtt_username, mqtt_password, interval } = data;

  const result = await performSetup(
    url, token,
    mqtt_broker, mqtt_port, mqtt_username, mqtt_password,
    interval || 30
  );

  if (result.success) {
    const cfg = config.loadConfig();
    mainWindow.loadURL(cfg.url);
    startCompanion();
  }

  return result;
});

// Get current config
ipcMain.handle('get-config', async () => {
  const cfg = config.loadConfig();
  return {
    url: cfg.url,
    has_token: !!cfg.token,
    mqtt_broker: cfg.mqtt_broker,
    mqtt_port: cfg.mqtt_port,
    update_interval: cfg.update_interval,
    device_id: cfg.device_id,
    is_configured: config.isConfigured(),
    mqtt_connected: haApi.getIsConnected(),
  };
});

// Save config changes
ipcMain.handle('save-config', async (event, newConfig) => {
  const allowed = {};
  if (newConfig.update_interval) {
    allowed.update_interval = parseInt(newConfig.update_interval, 10);
    sensorLoop.setInterval(allowed.update_interval);
  }
  config.saveConfig(allowed);
  return { success: true };
});

// Get sensor loop status
ipcMain.handle('get-sensor-status', async () => {
  return sensorLoop.getStatus();
});

// Get full config for settings modal (includes sensitive fields)
ipcMain.handle('get-full-config', async () => {
  const cfg = config.loadConfig();
  return {
    url: cfg.url,
    token: cfg.token,
    mqtt_broker: cfg.mqtt_broker,
    mqtt_port: cfg.mqtt_port,
    mqtt_username: cfg.mqtt_username,
    mqtt_password: cfg.mqtt_password,
    update_interval: cfg.update_interval,
    device_id: cfg.device_id,
  };
});

// Save all settings from the settings modal
ipcMain.handle('save-all-settings', async (event, data) => {
  try {
    const cfg = config.loadConfig();
    let needsReconnect = false;

    // Normalize URL
    let url = data.url.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'http://' + url;
    }
    if (url.endsWith('/')) url = url.slice(0, -1);

    // Check if MQTT broker changed
    if (data.mqtt_broker !== cfg.mqtt_broker ||
      parseInt(data.mqtt_port, 10) !== cfg.mqtt_port ||
      data.mqtt_username !== cfg.mqtt_username ||
      (data.mqtt_password && data.mqtt_password !== cfg.mqtt_password)) {
      needsReconnect = true;
    }

    // Save config (keep existing token/password if not provided)
    config.saveConfig({
      url,
      token: data.token || cfg.token,
      mqtt_broker: data.mqtt_broker,
      mqtt_port: parseInt(data.mqtt_port, 10) || 1883,
      mqtt_username: data.mqtt_username || null,
      mqtt_password: data.mqtt_password || cfg.mqtt_password || null,
      update_interval: data.interval,
    });

    // Update interval immediately
    sensorLoop.setInterval(data.interval);

    // If URL changed, reload main window
    if (url !== cfg.url) {
      mainWindow.loadURL(url);
    }

    // If MQTT broker changed, reconnect
    if (needsReconnect) {
      console.log('[main] MQTT settings changed, reconnecting...');
      sensorLoop.stop();
      haApi.disconnect();
      await startCompanion();
    }

    return { success: true };
  } catch (error) {
    console.error('[main] Save settings failed:', error.message);
    return { success: false, error: error.message };
  }
});

// Close settings window
ipcMain.handle('close-settings', async () => {
  // Settings is now an in-page overlay, closed by the renderer itself
});

// ============================================================
// App lifecycle
// ============================================================

app.whenReady().then(() => {
  if (gotTheLock) createWindow();
});

app.on('before-quit', () => {
  tray.setQuitting(true);
  sensorLoop.stop();
  haApi.disconnect();
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') {
    // macOS standard behavior
  }
  // App stays alive via tray
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    tray.showWindow();
  }
});
