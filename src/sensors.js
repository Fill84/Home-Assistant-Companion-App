// src/sensors.js — System sensor data collection via systeminformation
// OPTIMIZED: Uses native Node.js APIs where possible (CPU usage, memory, uptime).
// Expensive subprocess calls (GPU, temps, disk) are cached with staggered refresh.
// Static data (hardware info) is fetched ONCE at startup.

const si = require('systeminformation');
const os = require('os');
const { execFile } = require('child_process');

// ============================================================
// Caches — static info is fetched once, never again
// ============================================================

/** @type {object|null} Cached static system data from si.get() */
let cachedStaticData = null;

/** @type {Array|null} Sensor definitions (built once at registration) */
let sensorDefinitions = null;

/** @type {boolean} Whether NVIDIA GPU was detected at startup */
let hasNvidiaGpu = false;

/** @type {boolean} Whether battery was detected at startup */
let hasBattery = false;

/** @type {Array} Network interfaces detected at startup */
let activeIfaces = [];

/** @type {Array} Disk mounts detected at startup */
let diskMounts = [];

/** @type {Array} Disk layout indices with temperature sensors */
let diskTempIndices = [];

/** @type {string|null} CPU temperature method: 'si', 'wmi', or null */
let cpuTempMethod = null;

// ============================================================
// Native CPU tracking (zero cost, no child processes)
// ============================================================

let prevCpuTimes = null;

/**
 * Calculate CPU usage from os.cpus() time deltas.
 * No child processes spawned. Returns null on first call (needs two samples).
 */
function getCpuUsageNative() {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const cpu of cpus) {
        const t = cpu.times;
        idle += t.idle;
        total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    if (!prevCpuTimes) {
        prevCpuTimes = { idle, total };
        return null;
    }
    const dIdle = idle - prevCpuTimes.idle;
    const dTotal = total - prevCpuTimes.total;
    prevCpuTimes = { idle, total };
    return dTotal > 0 ? Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10 : 0;
}

// ============================================================
// Caching layer — expensive subprocesses run less often
// ============================================================

let tickCounter = 0;
let isCollecting = false;
let lastCollectedStates = [];

/** Cached results from expensive si/subprocess calls */
const expensiveCache = {
    cpuTemp: { data: null, tick: -100 },
    cpuSpeed: { data: null, tick: -100 },
    gpuData: { data: null, tick: -100 },
    diskUsage: { data: null, tick: -100 },
    diskTemps: { data: null, tick: -100 },
    netStats: { data: null, tick: -100 },
    swapMem: { data: { swaptotal: 0, swapused: 0 }, tick: -100 },
    battery: { data: {}, tick: -100 },
};

/**
 * Refresh intervals in ticks. At 30s: 2=60s, 4=120s, etc.
 * Staggered so expensive queries don't all fire on same tick.
 */
const REFRESH_TICKS = {
    cpuTemp: 2,   // 60s
    cpuSpeed: 3,   // 90s
    gpuData: 3,   // 90s — nvidia-smi is expensive
    diskUsage: 6,   // 180s — disk sizes change slowly
    diskTemps: 10,  // 300s — disk temps change slowly
    netStats: 1,   // every tick — most dynamic data
    swapMem: 6,   // 180s
    battery: 2,   // 60s
};

function needsRefresh(key) {
    return (tickCounter - expensiveCache[key].tick) >= REFRESH_TICKS[key];
}

// ============================================================
// Helpers
// ============================================================

/**
 * Windows fallback: get CPU temperature via WMI ThermalZoneInformation.
 * Works on Windows 10 1903+ without admin rights.
 * Returns temperature in °C or null.
 */
function getWindowsCpuTemp() {
    return new Promise((resolve) => {
        if (os.platform() !== 'win32') { resolve(null); return; }
        try {
            execFile('powershell', [
                '-NoProfile', '-NoLogo', '-Command',
                'Get-CimInstance -Namespace root/cimv2 -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction SilentlyContinue | Select-Object -ExpandProperty HighPrecisionTemperature -First 1'
            ], { timeout: 5000 }, (error, stdout) => {
                if (error) { resolve(null); return; }
                const raw = parseFloat(stdout.trim());
                if (isNaN(raw) || raw <= 0) { resolve(null); return; }
                // HighPrecisionTemperature is in tenths of Kelvin (e.g. 3030 = 303.0K = 29.85°C)
                const celsius = (raw / 10) - 273.15;
                if (celsius < 0 || celsius > 150) { resolve(null); return; }
                resolve(Math.round(celsius * 10) / 10);
            });
        } catch { resolve(null); }
    });
}

/**
 * Format a size in GB to a human-readable string.
 */
function formatSize(gb) {
    if (gb >= 1000) return `${Math.round(gb / 100) / 10} TB`;
    if (gb >= 10) return `${Math.round(gb)} GB`;
    if (gb >= 1) return `${Math.round(gb * 10) / 10} GB`;
    const mb = gb * 1024;
    if (mb >= 100) return `${Math.round(mb)} MB`;
    return `${Math.round(mb * 10) / 10} MB`;
}

/**
 * Get appropriate battery icon based on level.
 */
function getBatteryIcon(percent, charging) {
    const prefix = charging ? 'mdi:battery-charging' : 'mdi:battery';
    if (percent >= 90) return charging ? 'mdi:battery-charging-100' : 'mdi:battery';
    if (percent >= 70) return `${prefix}-80`;
    if (percent >= 50) return `${prefix}-60`;
    if (percent >= 30) return `${prefix}-40`;
    if (percent >= 10) return `${prefix}-20`;
    return charging ? 'mdi:battery-charging-outline' : 'mdi:battery-alert';
}



// ============================================================
// Static data — fetched ONCE at startup via si.get()
// ============================================================

/**
 * Fetch all static system info in ONE si.get() call.
 * This data doesn't change at runtime, so we cache it permanently.
 * Returns the cached result on subsequent calls.
 * 
 * Call resetSensorDefinitions() to force a refresh (e.g., if hardware changed).
 */
async function fetchStaticData() {
    if (cachedStaticData) {
        console.log('[sensors] Using cached static data (call resetSensorDefinitions() to refresh)');
        return cachedStaticData;
    }

    console.log('[sensors] Fetching static system data (one-time)...');

    const data = await si.get({
        system: 'manufacturer, model',
        baseboard: 'manufacturer, model',
        bios: 'vendor, version, releaseDate',
        cpu: 'manufacturer, brand, cores, physicalCores, speed',
        graphics: 'controllers',
        osInfo: 'platform, distro, release',
        networkInterfaces: 'iface, operstate, internal, ip4',
        fsSize: 'mount, size, used, use, type',
        diskLayout: 'name, temperature',
        battery: 'hasBattery',
    });

    // Detect NVIDIA GPU from si.graphics() controllers (already fetched above)
    const gpuControllers = data.graphics?.controllers || [];
    hasNvidiaGpu = gpuControllers.some(c => (c.vendor || '').toLowerCase().includes('nvidia'));

    // Cache battery presence
    hasBattery = data.battery?.hasBattery || false;

    // Cache active network interfaces
    const nets = Array.isArray(data.networkInterfaces) ? data.networkInterfaces : [];
    console.log(`[sensors] Found ${nets.length} network interfaces. Filtering for 'up' with IP4...`);

    // Strict filter: operstate='up', not internal, has IP4
    activeIfaces = nets.filter(n => n.operstate === 'up' && !n.internal && n.ip4);

    // Fallback: if strict filter found nothing but interfaces exist, use looser filter
    if (activeIfaces.length === 0 && nets.length > 0) {
        console.warn(`[sensors] WARNING: Strict filter (operstate='up') found no interfaces. Trying fallback filter...`);
        activeIfaces = nets.filter(n => !n.internal && n.ip4);
        if (activeIfaces.length > 0) {
            console.log(`[sensors] Fallback filter found ${activeIfaces.length} interfaces (ignoring operstate check)`);
        }
    }

    if (activeIfaces.length === 0) {
        console.warn(`[sensors] WARNING: No active network interfaces found! Network sensors will be unavailable.`);
    }

    // Cache disk mounts
    const disks = Array.isArray(data.fsSize) ? data.fsSize : [];
    diskMounts = disks.filter(d => d.mount && d.size > 0);

    // Cache disk layout indices that have temperature
    const layout = Array.isArray(data.diskLayout) ? data.diskLayout : [];
    diskTempIndices = [];
    for (let i = 0; i < layout.length; i++) {
        if (layout[i].temperature && layout[i].temperature > 0) {
            diskTempIndices.push({ index: i, name: layout[i].name || `Disk ${i}` });
        }
    }

    cachedStaticData = data;
    console.log('[sensors] Static data cached');
    return data;
}

// ============================================================
// Device info for MQTT registration
// ============================================================

/**
 * Get device info for MQTT discovery. Uses cached static data.
 */
async function getDeviceInfo() {
    const data = await fetchStaticData();

    const system = data.system || {};
    const baseboard = data.baseboard || {};
    const cpu = data.cpu || {};
    const osInfo = data.osInfo || {};
    const graphics = data.graphics || {};

    // Build manufacturer — prefer system, fallback to baseboard, then CPU
    const genericValues = ['system manufacturer', 'to be filled by o.e.m.', 'default string', '', 'unknown'];
    const isGeneric = (val) => !val || genericValues.includes(val.toLowerCase().trim());

    let manufacturer = system.manufacturer;
    if (isGeneric(manufacturer)) manufacturer = baseboard.manufacturer;
    if (isGeneric(manufacturer)) manufacturer = cpu.manufacturer;
    if (isGeneric(manufacturer)) manufacturer = 'Custom PC';

    // Build model — prefer system, fallback to CPU + GPU combo
    let model = system.model;
    if (isGeneric(model)) {
        const gpu = graphics.controllers?.[0];
        const parts = [cpu.brand];
        if (gpu?.model) parts.push(`/ ${gpu.model}`);
        model = parts.join(' ');
    }

    return {
        device_name: os.hostname(),
        manufacturer,
        model,
        os_name: osInfo.platform,
        os_version: `${osInfo.distro} ${osInfo.release}`,
    };
}

// ============================================================
// Sensor definitions — built once, determines which entities exist
// ============================================================

/**
 * Build sensor definitions based on available hardware.
 * Uses cached static data — no additional system calls needed.
 */
async function buildSensorDefinitions() {
    await fetchStaticData();
    const definitions = [];

    // --- CPU sensors (always present) ---
    definitions.push(
        {
            unique_id: 'pc_cpu_temp',
            name: 'CPU Temperatuur',
            type: 'sensor',
            device_class: 'temperature',
            unit_of_measurement: '\u00b0C',
            state_class: 'measurement',
            icon: 'mdi:thermometer',
        });

    definitions.push(
        {
            unique_id: 'pc_cpu_usage',
            name: 'CPU Gebruik',
            type: 'sensor',
            unit_of_measurement: '%',
            state_class: 'measurement',
            icon: 'mdi:cpu-64-bit',
        },
        {
            unique_id: 'pc_cpu_speed',
            name: 'CPU Snelheid',
            type: 'sensor',
            device_class: 'frequency',
            unit_of_measurement: 'GHz',
            state_class: 'measurement',
            icon: 'mdi:speedometer',
        }
    );

    // --- GPU sensors (only if NVIDIA detected at startup) ---
    if (hasNvidiaGpu) {
        definitions.push(
            {
                unique_id: 'pc_gpu_temp',
                name: 'GPU Temperatuur',
                type: 'sensor',
                device_class: 'temperature',
                unit_of_measurement: '\u00b0C',
                state_class: 'measurement',
                icon: 'mdi:expansion-card',
            },
            {
                unique_id: 'pc_gpu_usage',
                name: 'GPU Gebruik',
                type: 'sensor',
                unit_of_measurement: '%',
                state_class: 'measurement',
                icon: 'mdi:expansion-card-variant',
            }
        );
    }

    // --- Memory sensors ---
    definitions.push(
        {
            unique_id: 'pc_mem_usage',
            name: 'Geheugen Gebruik',
            type: 'sensor',
            icon: 'mdi:memory',
        },
        {
            unique_id: 'pc_mem_total',
            name: 'Geheugen Totaal',
            type: 'sensor',
            device_class: 'data_size',
            unit_of_measurement: 'GB',
            state_class: 'measurement',
            icon: 'mdi:memory',
        },
        {
            unique_id: 'pc_mem_percent',
            name: 'Geheugen Percentage',
            type: 'sensor',
            unit_of_measurement: '%',
            state_class: 'measurement',
            icon: 'mdi:memory',
        },
        {
            unique_id: 'pc_swap_usage',
            name: 'Swap Gebruik',
            type: 'sensor',
            icon: 'mdi:swap-horizontal',
        }
    );

    // --- Disk sensors (from cached mounts) ---
    for (const disk of diskMounts) {
        const id = disk.mount.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        definitions.push({
            unique_id: `pc_disk_${id}_usage`,
            name: `Schijf ${disk.mount} Gebruik`,
            type: 'sensor',
            icon: 'mdi:harddisk',
            _mount: disk.mount,
        });
    }

    // --- Disk temperature sensors (from cached layout) ---
    for (const dt of diskTempIndices) {
        const id = dt.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        definitions.push({
            unique_id: `pc_disk_${id}_temp`,
            name: `Schijf ${dt.name} Temperatuur`,
            type: 'sensor',
            device_class: 'temperature',
            unit_of_measurement: '\u00b0C',
            state_class: 'measurement',
            icon: 'mdi:harddisk',
            _disk_index: dt.index,
        });
    }

    // --- Network sensors (from cached interfaces) ---
    for (const net of activeIfaces) {
        const id = net.iface.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        definitions.push(
            {
                unique_id: `pc_net_${id}_rx`,
                name: `Netwerk ${net.iface} Download`,
                type: 'sensor',
                device_class: 'data_rate',
                unit_of_measurement: 'KB/s',
                state_class: 'measurement',
                icon: 'mdi:download-network',
                _iface: net.iface,
            },
            {
                unique_id: `pc_net_${id}_tx`,
                name: `Netwerk ${net.iface} Upload`,
                type: 'sensor',
                device_class: 'data_rate',
                unit_of_measurement: 'KB/s',
                state_class: 'measurement',
                icon: 'mdi:upload-network',
                _iface: net.iface,
            }
        );
    }

    // --- Battery sensors (only if battery detected) ---
    if (hasBattery) {
        definitions.push(
            {
                unique_id: 'pc_battery_level',
                name: 'Batterij Niveau',
                type: 'sensor',
                device_class: 'battery',
                unit_of_measurement: '%',
                state_class: 'measurement',
                icon: 'mdi:battery',
            },
            {
                unique_id: 'pc_battery_charging',
                name: 'Batterij Opladen',
                type: 'binary_sensor',
                device_class: 'battery_charging',
                icon: 'mdi:battery-charging',
            },
            {
                unique_id: 'pc_ac_connected',
                name: 'Netstroom Verbonden',
                type: 'binary_sensor',
                device_class: 'plug',
                icon: 'mdi:power-plug',
            }
        );
    }

    // Log detected hardware
    console.log('[sensors] Hardware detected: GPU=' + (hasNvidiaGpu ? 'NVIDIA' : 'none') +
        ', Battery=' + (hasBattery ? 'yes' : 'no') +
        ', Networks=' + activeIfaces.length +
        ', Disks=' + diskMounts.length +
        ', DiskTemps=' + diskTempIndices.length);

    // --- Static info sensors (values come from cache, sent once) ---
    definitions.push(
        {
            unique_id: 'pc_baseboard_manufacturer',
            name: 'Moederbord Fabrikant',
            type: 'sensor',
            icon: 'mdi:chip',
            _static: true,
        },
        {
            unique_id: 'pc_baseboard_model',
            name: 'Moederbord Model',
            type: 'sensor',
            icon: 'mdi:chip',
            _static: true,
        },
        {
            unique_id: 'pc_bios_version',
            name: 'BIOS Versie',
            type: 'sensor',
            icon: 'mdi:memory',
            _static: true,
        },
        {
            unique_id: 'pc_cpu_model',
            name: 'CPU Model',
            type: 'sensor',
            icon: 'mdi:cpu-64-bit',
            _static: true,
        },
        {
            unique_id: 'pc_gpu_model',
            name: 'GPU Model',
            type: 'sensor',
            icon: 'mdi:expansion-card',
            _static: true,
        },
        {
            unique_id: 'pc_gpu_vendor',
            name: 'GPU Fabrikant',
            type: 'sensor',
            icon: 'mdi:expansion-card',
            _static: true,
        },
        {
            unique_id: 'pc_gpu_vram',
            name: 'GPU VRAM',
            type: 'sensor',
            device_class: 'data_size',
            unit_of_measurement: 'MB',
            state_class: 'measurement',
            icon: 'mdi:expansion-card-variant',
            _static: true,
        },
        {
            unique_id: 'pc_gpu_driver',
            name: 'GPU Driver Versie',
            type: 'sensor',
            icon: 'mdi:update',
            _static: true,
        },
        {
            unique_id: 'pc_os_name',
            name: 'Besturingssysteem',
            type: 'sensor',
            icon: 'mdi:microsoft-windows',
            _static: true,
        },
        {
            unique_id: 'pc_os_version',
            name: 'OS Versie',
            type: 'sensor',
            icon: 'mdi:information-outline',
            _static: true,
        },
        {
            unique_id: 'pc_hostname',
            name: 'Hostname',
            type: 'sensor',
            icon: 'mdi:desktop-tower',
            _static: true,
        },
        {
            unique_id: 'pc_uptime',
            name: 'Uptime',
            type: 'sensor',
            icon: 'mdi:clock-outline',
            // uptime is dynamic, not static
        }
    );

    sensorDefinitions = definitions;

    // Log final sensor count breakdown
    const staticCount = definitions.filter(d => d._static).length;
    const dynamicCount = definitions.length - staticCount;
    console.log(`[sensors] Built ${definitions.length} sensor definitions (${staticCount} static, ${dynamicCount} dynamic)`);

    return definitions;
}

/**
 * Get cached sensor definitions, or build them.
 */
async function getSensorDefinitions() {
    if (!sensorDefinitions) {
        await buildSensorDefinitions();
    }
    return sensorDefinitions;
}

// ============================================================
// Static sensor states — resolved from cache, no system calls
// ============================================================

/**
 * Build state entries for all static sensors from cached data.
 * These values never change, so we compute them once.
 */
function getStaticSensorStates() {
    if (!cachedStaticData) return [];

    const data = cachedStaticData;
    const baseboard = data.baseboard || {};
    const bios = data.bios || {};
    const cpu = data.cpu || {};
    const graphics = data.graphics || {};
    const osInfo = data.osInfo || {};
    const gpu0 = graphics.controllers?.[0];

    const states = [];

    states.push({ unique_id: 'pc_baseboard_manufacturer', type: 'sensor', state: baseboard.manufacturer || 'unknown' });
    states.push({ unique_id: 'pc_baseboard_model', type: 'sensor', state: baseboard.model || 'unknown' });

    const biosState = bios.version ? `${bios.vendor || ''} ${bios.version}`.trim() : 'unknown';
    const biosEntry = { unique_id: 'pc_bios_version', type: 'sensor', state: biosState };
    if (bios.releaseDate) biosEntry.attributes = { release_date: bios.releaseDate };
    states.push(biosEntry);

    const cpuEntry = { unique_id: 'pc_cpu_model', type: 'sensor', state: cpu.brand || 'unknown' };
    if (cpu.cores) {
        cpuEntry.attributes = {
            cores: cpu.cores,
            physical_cores: cpu.physicalCores,
            speed_ghz: cpu.speed,
        };
    }
    states.push(cpuEntry);

    states.push({ unique_id: 'pc_gpu_model', type: 'sensor', state: gpu0?.model || gpu0?.name || 'unknown' });
    states.push({ unique_id: 'pc_gpu_vendor', type: 'sensor', state: gpu0?.vendor || gpu0?.subVendor || 'unknown' });
    states.push({ unique_id: 'pc_gpu_vram', type: 'sensor', state: gpu0?.vram || 'unknown' });
    states.push({ unique_id: 'pc_gpu_driver', type: 'sensor', state: gpu0?.driverVersion || 'unknown' });

    states.push({ unique_id: 'pc_os_name', type: 'sensor', state: osInfo.platform || 'unknown' });
    states.push({ unique_id: 'pc_os_version', type: 'sensor', state: `${osInfo.distro} ${osInfo.release}` });
    states.push({ unique_id: 'pc_hostname', type: 'sensor', state: os.hostname() });

    return states;
}

// ============================================================
// Dynamic sensor states — cached + native for low resource usage
// ============================================================

/**
 * Collect all sensor states.
 * Uses native Node.js APIs for CPU usage, memory, and uptime (zero cost).
 * Expensive subprocess calls (GPU, temps, disk) are cached and
 * refreshed on staggered intervals to minimize child process spawning.
 */
async function collectSensorStates() {
    // Prevent concurrent collections — avoids subprocess stacking
    if (isCollecting) {
        return lastCollectedStates;
    }
    isCollecting = true;
    tickCounter++;

    try {
        const defs = await getSensorDefinitions();
        const states = [];

        if (defs.length === 0) {
            console.error('[sensors] No sensor definitions found!');
            return [];
        }

        // =============================================================
        // TIER 1: Native Node.js data — zero cost, no child processes
        // =============================================================
        const cpuUsage = getCpuUsageNative();
        const memTotal = os.totalmem();
        const memUsed = memTotal - os.freemem();
        const uptimeSecs = Math.round(os.uptime());

        // =============================================================
        // TIER 2: Expensive si data — only refresh stale caches
        // Build a MINIMAL si.get() query for what's actually needed
        // =============================================================
        const siQuery = {};
        const refreshKeys = [];

        if (needsRefresh('cpuTemp')) { siQuery.cpuTemperature = 'main, cores'; refreshKeys.push('cpuTemp'); }
        if (needsRefresh('cpuSpeed')) { siQuery.cpuCurrentSpeed = 'avg'; refreshKeys.push('cpuSpeed'); }
        if (hasNvidiaGpu && needsRefresh('gpuData')) { siQuery.graphics = 'controllers'; refreshKeys.push('gpuData'); }
        if (needsRefresh('diskUsage')) { siQuery.fsSize = 'mount, size, used, use, type'; refreshKeys.push('diskUsage'); }
        if (diskTempIndices.length > 0 && needsRefresh('diskTemps')) { siQuery.diskLayout = 'name, temperature'; refreshKeys.push('diskTemps'); }
        if (activeIfaces.length > 0 && needsRefresh('netStats')) { siQuery['networkStats(*)'] = 'iface, rx_sec, tx_sec'; refreshKeys.push('netStats'); }
        if (needsRefresh('swapMem')) { siQuery.mem = 'swaptotal, swapused'; refreshKeys.push('swapMem'); }
        if (hasBattery && needsRefresh('battery')) { siQuery.battery = 'percent, isCharging, acConnected'; refreshKeys.push('battery'); }

        // ONE si.get() call with only stale queries (or nothing at all!)
        if (Object.keys(siQuery).length > 0) {
            console.log(`[sensors] tick ${tickCounter}: refreshing ${refreshKeys.join(', ')}`);
            const siData = await si.get(siQuery);

            if (siData.cpuTemperature) expensiveCache.cpuTemp = { data: siData.cpuTemperature, tick: tickCounter };
            if (siData.cpuCurrentSpeed) expensiveCache.cpuSpeed = { data: siData.cpuCurrentSpeed, tick: tickCounter };
            if (siData.graphics) expensiveCache.gpuData = { data: siData.graphics, tick: tickCounter };
            if (siData.fsSize) expensiveCache.diskUsage = { data: Array.isArray(siData.fsSize) ? siData.fsSize : [], tick: tickCounter };
            if (siData.diskLayout) expensiveCache.diskTemps = { data: Array.isArray(siData.diskLayout) ? siData.diskLayout : [], tick: tickCounter };
            if (siData.networkStats) expensiveCache.netStats = { data: Array.isArray(siData.networkStats) ? siData.networkStats : [], tick: tickCounter };
            if (siData.mem) expensiveCache.swapMem = { data: siData.mem, tick: tickCounter };
            if (siData.battery) expensiveCache.battery = { data: siData.battery, tick: tickCounter };
        }

        // CPU temp: WMI fallback (only on refresh ticks)
        let resolvedCpuTemp = expensiveCache.cpuTemp.data?.main ?? null;
        if (refreshKeys.includes('cpuTemp') && (!resolvedCpuTemp || resolvedCpuTemp <= 0) && cpuTempMethod !== 'si') {
            try {
                const wmiTemp = await getWindowsCpuTemp();
                if (wmiTemp) { resolvedCpuTemp = wmiTemp; cpuTempMethod = 'wmi'; }
                else if (cpuTempMethod === null) { cpuTempMethod = 'none'; }
            } catch { /* ignore */ }
        } else if (resolvedCpuTemp > 0) {
            cpuTempMethod = 'si';
        }

        // =============================================================
        // BUILD STATES from native + cached data
        // =============================================================
        const staticData = cachedStaticData || {};
        const baseboard = staticData.baseboard || {};
        const bios = staticData.bios || {};
        const cpuInfo = staticData.cpu || {};
        const osInfo = staticData.osInfo || {};
        const gpu0 = (staticData.graphics?.controllers)?.[0];

        const cpuTemp = expensiveCache.cpuTemp.data || { main: null };
        const cpuSpeed = expensiveCache.cpuSpeed.data || { avg: null };
        const gpuControllers = expensiveCache.gpuData.data?.controllers || [];
        const nvidiaGpu = gpuControllers.find(c => (c.vendor || '').toLowerCase().includes('nvidia'));
        const disks = expensiveCache.diskUsage.data || [];
        const diskLayout = expensiveCache.diskTemps.data || [];
        const netStats = expensiveCache.netStats.data || [];
        const swap = expensiveCache.swapMem.data || { swaptotal: 0, swapused: 0 };
        const batteryData = expensiveCache.battery.data || {};

        for (const def of defs) {
            const entry = { unique_id: def.unique_id, type: def.type };

            switch (def.unique_id) {
                // --- STATIC: Hardware Info (from cache, no subprocess) ---
                case 'pc_baseboard_manufacturer':
                    entry.state = baseboard.manufacturer || 'unknown';
                    break;
                case 'pc_baseboard_model':
                    entry.state = baseboard.model || 'unknown';
                    break;
                case 'pc_bios_version': {
                    const biosState = bios.version ? `${bios.vendor || ''} ${bios.version}`.trim() : 'unknown';
                    entry.state = biosState;
                    if (bios.releaseDate) entry.attributes = { release_date: bios.releaseDate };
                    break;
                }
                case 'pc_cpu_model': {
                    entry.state = cpuInfo.brand || 'unknown';
                    if (cpuInfo.cores) {
                        entry.attributes = {
                            cores: cpuInfo.cores,
                            physical_cores: cpuInfo.physicalCores,
                            speed_ghz: cpuInfo.speed,
                        };
                    }
                    break;
                }
                case 'pc_gpu_model':
                    entry.state = gpu0?.model || gpu0?.name || 'unknown';
                    break;
                case 'pc_gpu_vendor':
                    entry.state = gpu0?.vendor || gpu0?.subVendor || 'unknown';
                    break;
                case 'pc_gpu_vram':
                    entry.state = gpu0?.vram || 'unknown';
                    break;
                case 'pc_gpu_driver':
                    entry.state = gpu0?.driverVersion || 'unknown';
                    break;
                case 'pc_os_name':
                    entry.state = osInfo.platform || 'unknown';
                    break;
                case 'pc_os_version':
                    entry.state = `${osInfo.distro || ''} ${osInfo.release || ''}`.trim() || 'unknown';
                    break;
                case 'pc_hostname':
                    entry.state = os.hostname();
                    break;

                // --- DYNAMIC: CPU (native os.cpus() + cached temp/speed) ---
                case 'pc_cpu_temp': {
                    entry.state = (resolvedCpuTemp != null && resolvedCpuTemp > 0)
                        ? Math.round(resolvedCpuTemp * 10) / 10
                        : null;
                    if (cpuTemp.cores && cpuTemp.cores.length > 0) {
                        entry.attributes = { cores: cpuTemp.cores };
                    }
                    break;
                }
                case 'pc_cpu_usage':
                    entry.state = cpuUsage != null ? cpuUsage : 'unknown';
                    break;
                case 'pc_cpu_speed':
                    entry.state = cpuSpeed.avg != null
                        ? Math.round(cpuSpeed.avg * 100) / 100
                        : 'unknown';
                    break;

                // --- GPU (cached nvidia-smi data) ---
                case 'pc_gpu_temp':
                    entry.state = nvidiaGpu?.temperatureGpu ?? 'unknown';
                    if (nvidiaGpu?.name || nvidiaGpu?.model) {
                        entry.attributes = { gpu_name: nvidiaGpu.name || nvidiaGpu.model };
                    }
                    break;
                case 'pc_gpu_usage':
                    entry.state = nvidiaGpu?.utilizationGpu ?? 'unknown';
                    break;

                // --- Memory (native os.totalmem/freemem — zero cost) ---
                case 'pc_mem_usage':
                    if (memTotal > 0) {
                        const usedGB = memUsed / (1024 ** 3);
                        const totalGB = memTotal / (1024 ** 3);
                        entry.state = `${formatSize(usedGB)} / ${formatSize(totalGB)}`;
                    } else {
                        entry.state = 'unknown';
                    }
                    break;
                case 'pc_mem_total':
                    entry.state = memTotal > 0
                        ? Math.round((memTotal / (1024 ** 3)) * 10) / 10
                        : 'unknown';
                    break;
                case 'pc_mem_percent':
                    entry.state = memTotal > 0
                        ? Math.round((memUsed / memTotal) * 1000) / 10
                        : 'unknown';
                    break;
                case 'pc_swap_usage':
                    if (swap.swaptotal > 0) {
                        const swUsed = swap.swapused / (1024 ** 3);
                        const swTotal = swap.swaptotal / (1024 ** 3);
                        entry.state = `${formatSize(swUsed)} / ${formatSize(swTotal)}`;
                    } else {
                        entry.state = '0 GB / 0 GB';
                    }
                    break;

                // --- Battery (cached) ---
                case 'pc_battery_level':
                    entry.state = batteryData.percent ?? 'unknown';
                    entry.icon = getBatteryIcon(batteryData.percent, batteryData.isCharging);
                    break;
                case 'pc_battery_charging':
                    entry.state = batteryData.isCharging ?? false;
                    break;
                case 'pc_ac_connected':
                    entry.state = batteryData.acConnected ?? false;
                    break;

                // --- Uptime (native os.uptime() — zero cost) ---
                case 'pc_uptime': {
                    const days = Math.floor(uptimeSecs / 86400);
                    const hrs = Math.floor((uptimeSecs % 86400) / 3600);
                    const mins = Math.floor((uptimeSecs % 3600) / 60);
                    const parts = [];
                    if (days > 0) parts.push(`${days}d`);
                    if (hrs > 0 || days > 0) parts.push(`${hrs}u`);
                    parts.push(`${mins}m`);
                    entry.state = parts.join(' ');
                    break;
                }

                default:
                    // Dynamic disk usage sensors
                    if (def.unique_id.startsWith('pc_disk_') && def.unique_id.endsWith('_usage') && def._mount) {
                        const disk = disks.find(d => d.mount === def._mount);
                        if (disk) {
                            const usedGB = disk.used / (1024 ** 3);
                            const totalGB = disk.size / (1024 ** 3);
                            entry.state = `${formatSize(usedGB)} / ${formatSize(totalGB)}`;
                            entry.attributes = { percent: Math.round(disk.use * 10) / 10, fs_type: disk.type };
                        } else {
                            entry.state = 'unknown';
                        }
                    }
                    // Dynamic disk temperature sensors
                    else if (def.unique_id.startsWith('pc_disk_') && def.unique_id.endsWith('_temp') && def._disk_index != null) {
                        const d = diskLayout[def._disk_index];
                        entry.state = (d && d.temperature > 0) ? d.temperature : 'unknown';
                    }
                    // Dynamic network sensors
                    else if (def.unique_id.startsWith('pc_net_') && def._iface) {
                        const stat = netStats.find(s => s.iface === def._iface);
                        if (def.unique_id.endsWith('_rx')) {
                            entry.state = stat ? Math.round((stat.rx_sec / 1024) * 10) / 10 : 0;
                        } else if (def.unique_id.endsWith('_tx')) {
                            entry.state = stat ? Math.round((stat.tx_sec / 1024) * 10) / 10 : 0;
                        }
                    }
                    break;
            }
            states.push(entry);
        }

        lastCollectedStates = states;
        return states;
    } finally {
        isCollecting = false;
    }
}

/**
 * Force sensor definitions to be rebuilt (e.g., after hardware changes).
 * Also resets all caches so everything is re-fetched fresh.
 */
function resetSensorDefinitions() {
    sensorDefinitions = null;
    cachedStaticData = null;
    prevCpuTimes = null;
    tickCounter = 0;
    lastCollectedStates = [];
    // Reset all expensive caches
    for (const key of Object.keys(expensiveCache)) {
        expensiveCache[key] = { data: null, tick: -100 };
    }
    expensiveCache.swapMem = { data: { swaptotal: 0, swapused: 0 }, tick: -100 };
    expensiveCache.battery = { data: {}, tick: -100 };
}

module.exports = {
    getDeviceInfo,
    buildSensorDefinitions,
    getSensorDefinitions,
    collectSensorStates,
    getStaticSensorStates,
    resetSensorDefinitions,
};
