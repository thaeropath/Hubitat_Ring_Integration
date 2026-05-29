# Hubitat Ring Integration

Connects Ring cameras, sensors, alarm, locks, and smart lights to a Hubitat Elevation hub in real time — no polling, no cloud dependency for local event delivery.

## What it does

| Ring Device | Events in Hubitat | Commands from Hubitat |
|---|---|---|
| Camera / Doorbell | motion active/inactive, doorbell ding | — |
| Contact sensor | open / closed | — |
| Ring Alarm | armed-away, armed-home, disarmed + who triggered | arm away, arm home, disarm |
| Door lock | locked / unlocked + who triggered | lock, unlock |
| Smart light (via Ring Bridge) | on/off, brightness level | on, off, set level |

Alarm hub events (sensors, locks, alarm mode) arrive in real time via Ring's WebSocket push. Camera motion and doorbell ding are delivered by polling Ring's event history API every 20 seconds.

## How it works

A small Node.js bridge server runs on your local network and holds a persistent connection to Ring's cloud. When Ring pushes an event, the bridge immediately forwards it to your Hubitat hub. Commands flow the other way: Hubitat sends HTTP to the bridge, which calls the Ring API.

```
Ring Cloud ──(WebSocket push)──► Bridge Server ──(HTTP POST)──► Hubitat Hub
                                      ▲                               │
                                      └──────────(HTTP POST)──────────┘
                                              commands (arm, lock, etc.)
```

---

## Prerequisites

- Hubitat Elevation hub (any model), firmware 2.3+
- A Ring account with 2FA enabled
- One of the following to host the bridge:
  - Raspberry Pi (Zero 2W, 3, 4, or 5) — bare-metal or with Docker
  - Synology / QNAP NAS with Docker support
  - Any always-on Linux/Mac/Windows machine

---

## Step 1 — Get a Ring refresh token

On any machine with Node.js installed (does not need to be your Pi):

```bash
npx ring-auth-cli
```

Follow the prompts. After completing 2FA, the token is printed to stdout. **Copy and save it** — you'll need it in Step 3.

The token is valid until you revoke it or Ring expires it (~1 year). You only need to run this once.

---

## Step 2 — Install Hubitat drivers and app

1. In Hubitat UI, go to **Drivers Code → + New Driver** and paste each file:
   - `hubitat/drivers/RingMotionCamera.groovy`
   - `hubitat/drivers/RingContactSensor.groovy`
   - `hubitat/drivers/RingMotionSensor.groovy`
   - `hubitat/drivers/RingAlarmController.groovy`
   - `hubitat/drivers/RingLock.groovy`
   - `hubitat/drivers/RingSmartLight.groovy`

2. Go to **Apps Code → + New App** and paste:
   - `hubitat/apps/RingIntegrationApp.groovy`

3. Go to **Apps → + Add User App → Ring Integration**

4. In the app setup page:
   - Enter your bridge server's **IP address** and **port** (default: 3000)
   - Click **Save** — the app generates an access token and displays two lines to copy:
     ```
     HUBITAT_EVENT_URL=http://192.168.x.x/apps/api/42/ring/event
     HUBITAT_ACCESS_TOKEN=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
     ```
   - Keep this page open — you'll paste these into your `.env` in the next step

---

## Step 3 — Configure the bridge

Copy the example config:

```bash
cp bridge/.env.example bridge/.env
```

Edit `bridge/.env`:

```env
RING_REFRESH_TOKEN=<token from Step 1>
HUBITAT_EVENT_URL=<URL from Hubitat app setup page>
HUBITAT_ACCESS_TOKEN=<token from Hubitat app setup page>
BRIDGE_PORT=3000
LOG_LEVEL=info
```

**Optional variables** (add only if you need them):

| Variable | Default | Description |
|---|---|---|
| `ALARM_CONTROL` | `true` | Set to `false` to make the Ring Alarm read-only from Hubitat. Arm/disarm commands from Hubitat will be blocked; the alarm mode is still reported. |
| `LOG_LEVEL` | `info` | Set to `debug` to see every discovered device type — useful when sensors or lights are missing. |

---

## Step 4 — Deploy the bridge

Choose one of the three options below.

### Option A — Docker (Raspberry Pi with Docker, or NAS)

Works on Raspberry Pi 4/5/Zero 2W and any x86 NAS (Synology, QNAP, etc.).

```bash
# From the repo root
docker compose -f bridge/docker-compose.yml up -d
```

To check logs:
```bash
docker compose -f bridge/docker-compose.yml logs -f
```

To update after pulling new code:
```bash
docker compose -f bridge/docker-compose.yml up -d --build
```

Docker keeps the bridge running and automatically restarts it after a reboot.

---

### Option B — Bare-metal Raspberry Pi (no Docker)

**Requirements:** Node.js 20 LTS on your Pi (`sudo apt install nodejs npm`)

```bash
# Clone the repo on your Pi
git clone https://github.com/thaeropath/Hubitat_Ring_Integration.git
cd Hubitat_Ring_Integration/bridge

# Install dependencies and build
npm install
npm run build

# Copy and fill in your credentials
cp .env.example .env
nano .env
```

Install as a systemd service so it starts on boot:

```bash
# Edit the service file if your user is not 'pi' or install path differs
sudo cp docs/ring-bridge.service /etc/systemd/system/ring-bridge.service
sudo nano /etc/systemd/system/ring-bridge.service   # adjust User= and WorkingDirectory= if needed

sudo systemctl daemon-reload
sudo systemctl enable --now ring-bridge
```

Check that it's running:
```bash
sudo systemctl status ring-bridge
journalctl -u ring-bridge -f
```

To update:
```bash
git pull
npm install
npm run build
sudo systemctl restart ring-bridge
```

---

### Option C — Always-on PC or server

On any machine (Linux, macOS, Windows) that stays on:

```bash
cd bridge
npm install
npm run build
```

Use a process manager to keep it running:

```bash
# Install pm2 globally
npm install -g pm2

pm2 start dist/index.js --name ring-bridge
pm2 save                  # persist across reboots
pm2 startup               # follow the printed command to enable on boot
```

---

## Step 5 — Discover Ring devices in Hubitat

1. Back in Hubitat → **Apps → Ring Integration**
2. Click **Discover Ring Devices**
3. The app contacts your bridge, retrieves your Ring device list, and creates a child device for each one automatically
4. Devices appear under **Devices** in Hubitat, ready to use in rules and dashboards

---

## Verifying it works

**Smoke test** (lists Ring devices and exits — no Hubitat needed):
```bash
cd bridge
npm run smoke
```

**Check the bridge is reachable:**
```bash
curl http://<bridge-ip>:3000/health
# → {"ok":true,"devices":12}
```

**Watch live logs** (Docker):
```bash
docker compose -f bridge/docker-compose.yml logs -f
```

**Watch live logs** (systemd):
```bash
journalctl -u ring-bridge -f
```

---

## Troubleshooting

**Lights not appearing after discovery**
Ring Bridge-connected light device types vary. Set `LOG_LEVEL=debug` in `.env`, restart the bridge, and look for log lines showing each device's type. Add any unrecognised types to the `LIGHT_DEVICE_TYPES` set in `bridge/src/ring/client.ts`, rebuild, and re-run discovery.

**"Could not connect to bridge" in Hubitat**
- Confirm the bridge is running: `curl http://<bridge-ip>:3000/health`
- Check the IP/port entered in the Hubitat app match your `.env`
- Ensure the bridge host and Hubitat hub are on the same LAN segment

**Ring refresh token expired**
Re-run `npx ring-auth-cli`, update `RING_REFRESH_TOKEN` in `.env`, and restart the bridge. If the bridge logs a "token rotated" warning, the new token is printed — copy it to `.env`.

**Events not arriving in Hubitat**
Check that `HUBITAT_EVENT_URL` and `HUBITAT_ACCESS_TOKEN` in `.env` exactly match what the Hubitat app setup page displayed. The access token is regenerated if you uninstall and reinstall the app.

---

## Repository layout

```
bridge/                  Node.js bridge server (TypeScript)
├── src/
│   ├── index.ts         entry point
│   ├── config.ts        env var loading
│   ├── server.ts        HTTP API (commands from Hubitat)
│   ├── ring/            Ring API client and event handlers
│   └── hubitat/         HTTP client to Hubitat app endpoint
├── Dockerfile
├── docker-compose.yml
└── .env.example

hubitat/
├── apps/
│   └── RingIntegrationApp.groovy    parent app + install wizard
└── drivers/
    ├── RingMotionCamera.groovy
    ├── RingContactSensor.groovy
    ├── RingAlarmController.groovy
    ├── RingLock.groovy
    └── RingSmartLight.groovy

docs/
└── ring-bridge.service   systemd unit for bare-metal Pi
```

---

## Known limitations

- Ring has no official API — `ring-client-api` may break if Ring updates their backend
- Lock and alarm user attribution adds ~500 ms latency (requires a history API lookup)
- Camera live video streaming is not supported — only motion and ding events
- The bridge must be on the same LAN as the Hubitat hub
