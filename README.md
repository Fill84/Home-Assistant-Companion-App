# 🏠 Home Assistant Companion — Windows Desktop App

Een Electron-gebaseerde companion app voor [Home Assistant](https://www.home-assistant.io/) die je Windows PC als volledig sensorapparaat beschikbaar maakt via **MQTT Discovery**.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/Electron-latest-47848F?logo=electron)
![License](https://img.shields.io/badge/license-MIT-green)

---

## ✨ Features

- **Home Assistant dashboard** als native desktop venster
- **46+ hardware sensoren** automatisch beschikbaar in HA via MQTT Discovery
- **Systeemvak (tray)** — app draait op de achtergrond bij sluiten
- **Instellingen overlay** — configureer alles vanuit de app
- **Automatische cleanup** — verouderde sensoren worden automatisch opgeruimd
- **Last Will & Testament** — HA weet direct wanneer de PC offline gaat

---

## 📊 Sensoren

### Systeem

| Sensor | Beschrijving | Voorbeeld |
|---|---|---|
| CPU Temperatuur | Kerntemperatuur (WMI fallback) | `26 °C` |
| CPU Gebruik | Processorbelasting | `23 %` |
| CPU Snelheid | Huidige kloksnelheid | `4.2 GHz` |
| CPU Model | Processortype | `Intel® Core™ i7-12700K` |
| Geheugen Gebruik | Gebruikt / Totaal | `8.3 GB / 16.0 GB` |
| Geheugen Percentage | Geheugenbelasting | `26 %` |
| Swap Gebruik | Swap gebruikt / totaal | `1.2 GB / 4.0 GB` |
| Uptime | Tijd sinds laatste herstart | `2d 7u 45m` |

### Moederbord & BIOS

| Sensor | Beschrijving | Voorbeeld |
|---|---|---|
| Moederbord Fabrikant | Merk van het moederbord | `ASUSTeK COMPUTER INC.` |
| Moederbord Model | Modeltype | `ROG STRIX B660-A` |
| BIOS Versie | Firmwareversie | `1205` |

### GPU

| Sensor | Beschrijving | Voorbeeld |
|---|---|---|
| GPU Model | Videokaart naam | `NVIDIA GeForce RTX 4070` |
| GPU Fabrikant | Chipsetfabrikant | `NVIDIA` |
| GPU VRAM | Videogeheugen | `12288 MB` |
| GPU Driver Versie | Geïnstalleerde driver | `551.23` |
| GPU Temperatuur | Kerntemperatuur (nvidia-smi) | `45 °C` |
| GPU Gebruik | GPU-belasting | `12 %` |

### Opslag (per schijf)

| Sensor | Beschrijving | Voorbeeld |
|---|---|---|
| Schijf Gebruik | Gebruikt / Totaal | `234 GB / 512 GB` |
| Schijf Temperatuur | S.M.A.R.T. temperatuur | `38 °C` |

### Netwerk (per interface)

| Sensor | Beschrijving | Voorbeeld |
|---|---|---|
| Download | Inkomend verkeer | `1250 KB/s` |
| Upload | Uitgaand verkeer | `340 KB/s` |

### Batterij (indien aanwezig)

| Sensor | Beschrijving |
|---|---|
| Batterij Niveau | Percentage |
| Batterij Opladen | Aan het laden (ja/nee) |
| Netstroom Verbonden | Adapter aangesloten (ja/nee) |

### Overig

| Sensor | Beschrijving |
|---|---|
| Besturingssysteem | OS naam |
| OS Versie | Versienummer |
| Hostname | Computernaam |

---

## 🔧 Vereisten

- **Windows 10/11**
- **Home Assistant** met netwerktoegang
- **MQTT Broker** (bijv. [Mosquitto](https://mosquitto.org/))
- **MQTT Integration** geconfigureerd in Home Assistant
- **Long-Lived Access Token** — maak aan via HA Profiel → Beveiligingstokens

---

## 🚀 Installatie

### Vanuit broncode

```bash
# Clone de repository
git clone https://github.com/Fill84/Home-Assistant-Windows-App.git
cd Home-Assistant-Windows-App

# Installeer dependencies
yarn

# Start de app
yarn start
```

### Bouwen als Windows installer

```bash
yarn make
```

De installer verschijnt in `out/make/squirrel.windows/`.

---

## ⚙️ Configuratie

Bij de eerste keer starten verschijnt een setup-scherm:

1. **Home Assistant URL** — bijv. `https://homeassistant.local:8123`
2. **Long-Lived Access Token** — uit HA Profiel
3. **MQTT Broker** — IP-adres of hostname van je broker
4. **MQTT Poort** — standaard `1883`
5. **MQTT Gebruikersnaam/Wachtwoord** — optioneel (bij anonymous access)
6. **Update interval** — hoe vaak sensoren worden bijgewerkt (15s–5min)

Na configuratie laadt de app je Home Assistant dashboard en beginnen de sensoren automatisch te publiceren.

---

## 🏗️ Architectuur

```
┌─────────────────────────────────────┐
│         Electron (main.js)          │
│  ┌───────────┐  ┌────────────────┐  │
│  │  BrowserWindow (HA Dashboard) │  │
│  └───────────┘  └────────────────┘  │
│  ┌───────────┐  ┌────────────────┐  │
│  │ Tray Icon  │  │ Settings Modal │  │
│  └───────────┘  └────────────────┘  │
├─────────────────────────────────────┤
│            src/                      │
│  ┌─────────────┐ ┌───────────────┐  │
│  │  sensors.js  │ │  ha-api.js    │  │
│  │ (systeminf.) │ │ (MQTT client) │  │
│  └──────┬──────┘ └───────┬───────┘  │
│         │                 │          │
│  ┌──────┴─────────────────┴───────┐  │
│  │       sensor-loop.js           │  │
│  │   (periodieke sensor polling)  │  │
│  └────────────────────────────────┘  │
│  ┌────────────────────────────────┐  │
│  │         config.js              │  │
│  │  (JSON config persistentie)    │  │
│  └────────────────────────────────┘  │
└─────────────────────────────────────┘
          │
          │ MQTT
          ▼
┌─────────────────────┐
│   Mosquitto Broker   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   Home Assistant     │
│  (MQTT Integration)  │
│                      │
│  📊 46+ sensoren     │
│  automatisch via     │
│  MQTT Discovery      │
└─────────────────────┘
```

### MQTT Topics

| Topic | Doel |
|---|---|
| `homeassistant/sensor/<device_id>/<sensor_id>/config` | Discovery configuratie (retained) |
| `<device_id>/sensors` | Sensorwaarden (JSON) |
| `<device_id>/status` | Beschikbaarheid (`online`/`offline`) |

---

## 🖥️ Gebruik

- **Systeemvak** — de app minimaliseert naar het systeemvak bij sluiten
- **Dubbelklik** op het tray-icoon om het venster te tonen
- **Rechtermuisklik** op het tray-icoon voor het contextmenu:
  - *Toon/Verberg Venster*
  - *Instellingen* — open de instellingen overlay
  - *Afsluiten* — sluit de app volledig af

---

## 🛠️ Ontwikkeling

```bash
# Start in development mode
yarn start

# Package zonder installer
yarn package

# Bouw Windows installer (Squirrel)
yarn make
```

### Projectstructuur

```
├── main.js              # Electron hoofdproces
├── preload.js           # IPC bridge + settings overlay
├── setup.html           # Eerste-keer setup pagina
├── forge.config.js      # Electron Forge build config
├── package.json
├── assets/
│   ├── icon.ico         # App icoon (multi-size)
│   └── icon.png         # App icoon (256px)
└── src/
    ├── config.js        # Configuratie opslag
    ├── ha-api.js        # MQTT Discovery client
    ├── sensors.js       # Hardware sensor collectie
    ├── sensor-loop.js   # Periodieke sensor polling
    └── tray.js          # Systeemvak beheer
```

---

## 📝 Waarom MQTT en niet Mobile App?

Home Assistant filtert standaard alle entiteiten van het `mobile_app` platform uit het **Overzicht dashboard** ([bron](https://github.com/home-assistant/frontend/blob/dev/src/panels/lovelace/strategies/original-states/original-states-strategy.ts)). Omdat dit een **desktop** app is en geen mobiel apparaat, registreert deze app sensoren via **MQTT Discovery**. Hierdoor verschijnen alle sensoren direct op het Overzicht dashboard zonder extra configuratie.

---

## 📄 Licentie

[MIT](LICENSE) — Phillippe Pelzer

---

## 🙏 Credits

- [Electron](https://www.electronjs.org/)
- [Home Assistant](https://www.home-assistant.io/)
- [systeminformation](https://github.com/sebhildebrandt/systeminformation)
- [MQTT.js](https://github.com/mqttjs/MQTT.js)
- [Mosquitto](https://mosquitto.org/)

