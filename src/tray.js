// src/tray.js — System tray icon and menu
const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

let tray = null;
let mainWindow = null;
let isQuitting = false;
let onSettingsClick = null;

/**
 * Get the icon path, handling both packaged and development modes.
 */
function getIconPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'assets', 'icon.ico');
    }
    return path.join(__dirname, '..', 'assets', 'icon.ico');
}

/**
 * Initialize the system tray.
 * @param {BrowserWindow} window - The main application window
 */
function initTray(window) {
    mainWindow = window;

    const iconPath = getIconPath();
    tray = new Tray(iconPath);
    tray.setToolTip('Home Assistant Companion');

    // Build context menu
    updateContextMenu();

    // Double-click: show and focus window
    tray.on('double-click', () => {
        showWindow();
    });

    // Override window close to hide to tray instead
    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
            updateContextMenu();
        }
    });

    // Update menu when window is shown/hidden
    mainWindow.on('show', () => updateContextMenu());
    mainWindow.on('hide', () => updateContextMenu());

    console.log('[tray] System tray initialized');
}

/**
 * Update the context menu based on current window state.
 */
function updateContextMenu() {
    if (!tray || !mainWindow) return;

    const isVisible = mainWindow.isVisible();

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Home Assistant Companion',
            enabled: false,
            icon: nativeImage.createFromPath(getIconPath()).resize({ width: 16, height: 16 }),
        },
        { type: 'separator' },
        {
            label: isVisible ? 'Verberg Venster' : 'Toon Venster',
            click: () => {
                if (mainWindow.isVisible()) {
                    mainWindow.hide();
                } else {
                    showWindow();
                }
            },
        },
        { type: 'separator' },
        {
            label: 'Instellingen',
            icon: nativeImage.createFromPath(getIconPath()).resize({ width: 16, height: 16 }),
            click: () => {
                showWindow();
                if (onSettingsClick) onSettingsClick();
            },
        },
        { type: 'separator' },
        {
            label: 'Afsluiten',
            click: () => {
                quitApp();
            },
        },
    ]);

    tray.setContextMenu(contextMenu);
}

/**
 * Show the main window and bring it to focus.
 */
function showWindow() {
    if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
    }
}

/**
 * Set the quitting flag and quit the app.
 */
function quitApp() {
    isQuitting = true;
    app.quit();
}

/**
 * Set the quitting flag externally (e.g., from app.on('before-quit')).
 */
function setQuitting(value) {
    isQuitting = value;
}

/**
 * Check if app is in quitting state.
 */
function getQuitting() {
    return isQuitting;
}

/**
 * Destroy the tray icon.
 */
function destroy() {
    if (tray) {
        tray.destroy();
        tray = null;
    }
}

/**
 * Show a balloon notification (Windows only).
 * @param {string} title
 * @param {string} content
 */
function showBalloon(title, content) {
    if (tray) {
        tray.displayBalloon({
            iconType: 'info',
            title,
            content,
        });
    }
}

/**
 * Set callback for when Settings is clicked in the tray menu.
 * @param {Function} callback
 */
function setOnSettingsClick(callback) {
    onSettingsClick = callback;
}

module.exports = {
    initTray,
    showWindow,
    quitApp,
    setQuitting,
    getQuitting,
    destroy,
    showBalloon,
    updateContextMenu,
    setOnSettingsClick,
};
