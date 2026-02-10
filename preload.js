// preload.js — Secure IPC bridge between renderer and main process
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Setup: connect & register with HA via MQTT Discovery
    // Accepts { url, token, mqtt_broker, mqtt_port, mqtt_username, mqtt_password, interval }
    connect: (data) => ipcRenderer.invoke('connect-to-ha', data),

    // Get current configuration
    getConfig: () => ipcRenderer.invoke('get-config'),

    // Get full config (including sensitive fields) for settings modal
    getFullConfig: () => ipcRenderer.invoke('get-full-config'),

    // Save updated settings (e.g., interval change)
    saveConfig: (config) => ipcRenderer.invoke('save-config', config),

    // Save all settings from the settings modal
    saveAllSettings: (config) => ipcRenderer.invoke('save-all-settings', config),

    // Get sensor loop status
    getSensorStatus: () => ipcRenderer.invoke('get-sensor-status'),

    // Listen for show-settings event from main process (tray menu click)
    onShowSettings: (callback) => ipcRenderer.on('show-settings', callback),
});

// Inject settings modal overlay when main process requests it
ipcRenderer.on('show-settings', async () => {
    // Always remove the old overlay and create a fresh one with current config
    const existingOverlay = document.getElementById('ha-settings-overlay');
    if (existingOverlay) {
        existingOverlay.remove();
    }

    const cfg = await ipcRenderer.invoke('get-full-config');

    const overlay = document.createElement('div');
    overlay.id = 'ha-settings-overlay';
    overlay.innerHTML = `
<style>
#ha-settings-overlay {
    position: fixed; inset: 0; z-index: 999999;
    background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
    display: flex; justify-content: center; align-items: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #e0e0e0; animation: haFadeIn 0.2s ease;
}
@keyframes haFadeIn { from { opacity:0 } to { opacity:1 } }
@keyframes haSlideIn { from { transform:translateY(20px);opacity:0 } to { transform:translateY(0);opacity:1 } }
#ha-settings-overlay * { box-sizing: border-box; }
#ha-settings-panel {
    background: linear-gradient(135deg, #1e2235 0%, #192039 50%, #142952 100%);
    padding: 24px 28px 28px; border-radius: 14px;
    box-shadow: 0 16px 64px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08);
    width: 420px; max-height: 85vh; overflow-y: auto;
    animation: haSlideIn 0.25s ease;
}
#ha-settings-panel::-webkit-scrollbar { width: 5px; }
#ha-settings-panel::-webkit-scrollbar-track { background: transparent; }
#ha-settings-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
.ha-s-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
.ha-s-header h2 { margin:0; font-size:1.2rem; color:#fff; }
.ha-s-close { background:none; border:none; color:#667; font-size:20px; cursor:pointer; padding:4px 8px; border-radius:6px; transition:all 0.15s; }
.ha-s-close:hover { background:rgba(255,255,255,0.08); color:#fff; }
.ha-s-section { text-align:left; font-size:0.8rem; font-weight:600; color:#03a9f4; margin-top:14px; margin-bottom:4px; padding-bottom:3px; border-bottom:1px solid rgba(3,169,244,0.15); }
.ha-s-label { display:block; text-align:left; font-size:0.78rem; color:#8899aa; margin:8px 0 3px; }
.ha-s-input, .ha-s-select {
    width:100%; padding:8px 10px; border:1px solid rgba(255,255,255,0.1); border-radius:7px;
    background:rgba(255,255,255,0.05); color:#fff; font-size:13px; transition:border-color 0.2s;
}
.ha-s-input::placeholder { color:#556677; }
.ha-s-input:focus, .ha-s-select:focus { outline:none; border-color:#03a9f4; background:rgba(255,255,255,0.08); }
.ha-s-select option { background:#1e2235; color:#fff; }
.ha-s-hint { font-size:0.68rem; color:#4a5568; text-align:left; margin-top:1px; }
.ha-s-row { display:flex; gap:10px; }
.ha-s-row > div { flex:1; }
.ha-s-row > div.ha-s-sm { flex:0 0 76px; }
.ha-s-btns { display:flex; gap:10px; margin-top:18px; }
.ha-s-btns button { flex:1; padding:9px; border:none; border-radius:7px; cursor:pointer; font-size:13px; font-weight:600; transition:all 0.15s; }
.ha-s-btn-cancel { background:rgba(255,255,255,0.06); color:#8899aa; border:1px solid rgba(255,255,255,0.08) !important; }
.ha-s-btn-cancel:hover { background:rgba(255,255,255,0.1); color:#ccc; }
.ha-s-btn-save { background:linear-gradient(135deg,#03a9f4,#0288d1); color:#fff; }
.ha-s-btn-save:hover { background:linear-gradient(135deg,#29b6f6,#0399e5); box-shadow:0 3px 10px rgba(3,169,244,0.3); }
.ha-s-btn-save:disabled { background:#333; color:#666; cursor:not-allowed; }
.ha-s-msg { margin-top:10px; font-size:11px; text-align:center; display:none; }
.ha-s-msg.error { color:#ff6b6b; display:block; background:rgba(255,100,100,0.08); padding:5px 8px; border-radius:6px; }
.ha-s-msg.status { color:#03a9f4; display:block; }
.ha-s-spinner { display:inline-block; width:11px; height:11px; border:2px solid rgba(3,169,244,0.3); border-top-color:#03a9f4; border-radius:50%; animation:haSpin 0.7s linear infinite; vertical-align:middle; margin-right:4px; }
@keyframes haSpin { to { transform:rotate(360deg) } }
</style>
<div id="ha-settings-panel">
    <div class="ha-s-header">
        <h2>⚙️ Instellingen</h2>
        <button class="ha-s-close" id="ha-s-close" title="Sluiten">✕</button>
    </div>
    <div class="ha-s-section">🏠 Home Assistant</div>
    <label class="ha-s-label">Server Adres</label>
    <input class="ha-s-input" id="ha-s-url" type="text" placeholder="https://homeassistant.local:8123" value="${cfg.url || ''}" />
    <label class="ha-s-label">Long-Lived Access Token</label>
    <input class="ha-s-input" id="ha-s-token" type="password" placeholder="${cfg.token ? '••••••••  (opgeslagen)' : 'Plak je token hier...'}" />
    <div class="ha-s-hint">Laat leeg om het huidige token te behouden</div>

    <div class="ha-s-section">📡 MQTT Broker</div>
    <div class="ha-s-row">
        <div><label class="ha-s-label">Broker Adres</label>
        <input class="ha-s-input" id="ha-s-broker" type="text" placeholder="192.168.178.22" value="${cfg.mqtt_broker || ''}" /></div>
        <div class="ha-s-sm"><label class="ha-s-label">Poort</label>
        <input class="ha-s-input" id="ha-s-port" type="number" value="${cfg.mqtt_port || 1883}" /></div>
    </div>
    <div class="ha-s-row">
        <div><label class="ha-s-label">Gebruiker</label>
        <input class="ha-s-input" id="ha-s-user" type="text" placeholder="Optioneel" value="${cfg.mqtt_username || ''}" /></div>
        <div><label class="ha-s-label">Wachtwoord</label>
        <input class="ha-s-input" id="ha-s-pass" type="password" placeholder="${cfg.mqtt_password ? '••••••••  (opgeslagen)' : 'Optioneel'}" /></div>
    </div>

    <div class="ha-s-section">⚙️ Overig</div>
    <label class="ha-s-label">Update Interval</label>
    <select class="ha-s-select" id="ha-s-interval">
        <option value="15" ${cfg.update_interval == 15 ? 'selected' : ''}>Elke 15 seconden</option>
        <option value="30" ${cfg.update_interval == 30 || !cfg.update_interval ? 'selected' : ''}>Elke 30 seconden</option>
        <option value="60" ${cfg.update_interval == 60 ? 'selected' : ''}>Elke 60 seconden</option>
        <option value="120" ${cfg.update_interval == 120 ? 'selected' : ''}>Elke 2 minuten</option>
        <option value="300" ${cfg.update_interval == 300 ? 'selected' : ''}>Elke 5 minuten</option>
    </select>

    <div class="ha-s-btns">
        <button class="ha-s-btn-cancel" id="ha-s-cancel">Annuleren</button>
        <button class="ha-s-btn-save" id="ha-s-save">Opslaan</button>
    </div>
    <div class="ha-s-msg" id="ha-s-msg"></div>
</div>`;

    document.body.appendChild(overlay);

    const close = () => {
        overlay.style.display = 'none';
    };

    document.getElementById('ha-s-close').onclick = close;
    document.getElementById('ha-s-cancel').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function escHandler(e) {
        if (e.key === 'Escape' && overlay.style.display !== 'none') {
            close();
        }
    });

    document.getElementById('ha-s-save').onclick = async () => {
        const url = document.getElementById('ha-s-url').value.trim();
        const token = document.getElementById('ha-s-token').value.trim();
        const broker = document.getElementById('ha-s-broker').value.trim();
        const port = document.getElementById('ha-s-port').value.trim() || '1883';
        const user = document.getElementById('ha-s-user').value.trim();
        const pass = document.getElementById('ha-s-pass').value.trim();
        const interval = parseInt(document.getElementById('ha-s-interval').value, 10);
        const msg = document.getElementById('ha-s-msg');
        const btn = document.getElementById('ha-s-save');

        if (!url) { msg.className = 'ha-s-msg error'; msg.textContent = 'Voer een HA adres in.'; return; }
        if (!broker) { msg.className = 'ha-s-msg error'; msg.textContent = 'Voer het MQTT broker adres in.'; return; }

        btn.disabled = true;
        msg.className = 'ha-s-msg status';
        msg.innerHTML = '<span class="ha-s-spinner"></span>Opslaan...';

        try {
            const result = await ipcRenderer.invoke('save-all-settings', {
                url, token: token || null, mqtt_broker: broker, mqtt_port: port,
                mqtt_username: user || null, mqtt_password: pass || null, interval,
            });
            if (result.success) {
                msg.className = 'ha-s-msg status'; msg.textContent = '✓ Opgeslagen!';
                setTimeout(close, 600);
            } else {
                btn.disabled = false;
                msg.className = 'ha-s-msg error'; msg.textContent = result.error || 'Opslaan mislukt.';
            }
        } catch (e) {
            btn.disabled = false;
            msg.className = 'ha-s-msg error'; msg.textContent = 'Onverwachte fout.';
        }
    };
});
