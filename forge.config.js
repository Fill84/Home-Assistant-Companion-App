const path = require('path');

module.exports = {
    packagerConfig: {
        icon: './assets/icon',
        extraResource: ['./assets'],
        name: 'Home Assistant Companion',
        executableName: 'home-assistant-companion',
    },
    rebuildConfig: {},
    makers: [
        // ─── Windows (Squirrel) ───
        {
            name: '@electron-forge/maker-squirrel',
            config: {
                name: 'home_assistant_companion',
                setupIcon: './assets/icon.ico',
                iconUrl: 'file:///' + path.resolve(__dirname, 'assets', 'icon.ico').replace(/\\/g, '/'),
                shortcutFolderName: 'Home Assistant Companion',
                createDesktopShortcut: true,
                createStartMenuShortcut: true,
                shortcutName: 'Home Assistant Companion',
            },
        },
        // ─── macOS (DMG) ───
        {
            name: '@electron-forge/maker-dmg',
            config: {
                name: 'Home Assistant Companion',
                icon: './assets/icon.icns',
                format: 'ULFO',
            },
        },
        // ─── macOS / Universal (ZIP) ───
        {
            name: '@electron-forge/maker-zip',
            platforms: ['darwin'],
        },
        // ─── Linux (DEB) ───
        {
            name: '@electron-forge/maker-deb',
            config: {
                options: {
                    name: 'home-assistant-companion',
                    productName: 'Home Assistant Companion',
                    icon: './assets/icon.png',
                    categories: ['Utility'],
                    description: 'Home Assistant Companion App - Desktop sensor integration',
                    maintainer: 'Phillippe Pelzer',
                },
            },
        },
        // ─── Linux (RPM) ───
        {
            name: '@electron-forge/maker-rpm',
            config: {
                options: {
                    name: 'home-assistant-companion',
                    productName: 'Home Assistant Companion',
                    icon: './assets/icon.png',
                    categories: ['Utility'],
                    description: 'Home Assistant Companion App - Desktop sensor integration',
                },
            },
        },
    ],
};