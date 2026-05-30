# Hubitat Ring Integration

Connects Ring cameras, sensors, alarm, locks, and smart lights to a Hubitat Elevation hub using a lightweight Node.js bridge server that runs on your local network.

## What it does

| Ring Device | Events in Hubitat | Commands from Hubitat |
|---|---|---|
| Camera / Doorbell | motion active/inactive, doorbell ding | — |
| Contact sensor | open / closed | — |
| Alarm hub motion sensor (PIR) | motion active/inactive | — |
| Ring Alarm | armed-away, armed-home, disarmed + who triggered | arm away, arm home, disarm |
| Door lock | locked / unlocked + who triggered | lock, unlock |
| Smart light (via Ring Bridge) | on/off, brightness level | on, off, set level |

**How events are delivered:**
- Alarm hub devices (contact sensors, motion sensors, alarm mode, locks, lights) arrive in real time via Ring's alarm hub WebSocket — the same channel the Ring app uses. No polling.
- Camera motion and doorbell ding use FCM push notifications for immediate delivery, with a REST polling fallback every 20 seconds. If your network blocks FCM (`mtalk.google.com:5228`), set `CAMERA_PUSH=false` in `.env` and polling takes over seamlessly.

## How it works

A small Node.js bridge server runs on your local network and holds a persistent WebSocket connection to Ring's cloud. When Ring pushes an event, the bridge forwards it to Hubitat immediately. Commands flow the other way: Hubitat POSTs to the bridge, which calls the Ring API.

```
Ring Cloud ──(WebSocket push)──► Bridge Server ──(HTTP POST)──► Hubitat Hub
                                      ▲                               │
                                      └──────────(HTTP POST)──────────┘
                                              commands (arm, lock, etc.)
```

The bridge uses the unofficial [`ring-client-api`](https://github.com/dgreif/ring) library. No Hubitat Maker API is required — the Ring Integration app creates its own OAuth endpoint directly on the hub.

---

## Installation

### Option 1 — Hubitat Package Manager (recommended)

If you have [Hubitat Package Manager](https://hubitatpackagemanager.hubitatcommunity.com/) installed:

1. HPM → **Install** → **Search by Keywords** → search for **Ring Integration**
2. Follow the prompts — HPM installs all drivers and the app automatically
3. Continue from **Step 2** below (configure and deploy the bridge)

### Option 2 — Manual install

1. In Hubitat UI, go to **Drivers Code → + New Driver** and paste each file:
   - `hubitat/drivers/RingMotionCamera.groovy`
   - `hubitat/drivers/RingContactSensor.groovy`
   - `hubitat/drivers/RingMotionSensor.groovy`
   - `hubitat/drivers/RingAlarmController.groovy`
   - `hubitat/drivers/RingLock.groovy`
   - `hubitat/drivers/RingSmartLight.groovy`

2. Go to **Apps Code → + New App** → paste `hubitat/apps/RingIntegrationApp.groovy`
   > **Important:** After saving the app code, click the **OAuth** button that appears — this is required before installing the app instance.

---

## Step 1 — Get a Ring refresh token

On any machine with Node.js installed (does not need to be your Pi or NAS):

```bash
npx ring-auth-cli
```

Follow the prompts and complete 2FA. The refresh token is printed to stdout — **copy and save it**. You only need to do this once; the bridge automatically handles Ring's token rotation from then on.

---

## Step 2 — Configure the Hubitat app

1. Hubitat → **Apps → + Add User App → Ring Integration**
2. Enter your bridge server's **IP address** and **port** (default: 3000)
3. Click **Save** — the app generates an access token and displays two lines:
   ```
   HUBITAT_EVENT_URL=http://192.168.x.x/apps/api/42/ring/event
   HUBITAT_ACCESS_TOKEN=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```
4. Keep this page open — you'll need these values in the next step

---

## Step 3 — Configure the bridge

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

**Optional variables:**

| Variable | Default | Description |
|---|---|---|
| `ALARM_CONTROL` | `true` | Set to `false` to make the Ring Alarm read-only from Hubitat. Arm/disarm commands are blocked; alarm mode still reports. |
| `CAMERA_PUSH` | `true` | Set to `false` to disable FCM push for camera motion/ding. Use if your network blocks `mtalk.google.com:5228`. |
| `CAMERA_POLLING` | `true` | Set to `false` to disable REST polling for camera events. Only set this once push is confirmed working. |
| `LOG_LEVEL` | `info` | Set to `debug` to see every discovered device type and skipped device — useful when sensors or lights are missing. |

---

## Step 4 — Deploy the bridge

Choose one option:

### Option A — Docker (Raspberry Pi with Docker, or NAS)

Works on Raspberry Pi 4/5/Zero 2W and any x86-64 NAS (Synology, QNAP, etc.).

```bash
# From the repo root
docker compose -f bridge/docker-compose.yml up -d
```

```bash
# View logs
docker compose -f bridge/docker-compose.yml logs -f
```

Docker keeps the bridge running and restarts it automatically after a reboot. Your Ring refresh token is persisted in a Docker volume so container rebuilds don't require re-authentication.

---

### Option B — Bare-metal Raspberry Pi (no Docker)

**Requires:** Node.js 20 LTS (`sudo apt install nodejs npm`)

```bash
git clone https://github.com/thaeropath/Hubitat_Ring_Integration.git
cd Hubitat_Ring_Integration/bridge
npm install && npm run build
cp .env.example .env
nano .env
```

Install as a systemd service so it starts on boot:

```bash
sudo cp docs/ring-bridge.service /etc/systemd/system/ring-bridge.service
sudo nano /etc/systemd/system/ring-bridge.service   # adjust User= and WorkingDirectory= if needed
sudo systemctl daemon-reload
sudo systemctl enable --now ring-bridge
journalctl -u ring-bridge -f
```

---

### Option C — Always-on PC or server

```bash
cd bridge
npm install && npm run build
npm install -g pm2
pm2 start dist/index.js --name ring-bridge
pm2 save && pm2 startup
```

---

## Step 5 — Discover Ring devices in Hubitat

1. Hubitat → **Apps → Ring Integration**
2. Watch the bridge logs — wait until you see:
   ```
   ✔ Ready for Hubitat device discovery — tap "Discover Ring Devices" now
   ```
   This line appears ~5–10 seconds after startup when the alarm hub WebSocket connects. Running discovery before this line appears will miss alarm hub devices (contact sensors, motion sensors, locks, lights).
3. Back in Hubitat, select the device types you want to import, then tap **Discover Ring Devices**
4. Devices appear under **Devices**, ready to use in rules and dashboards

---

## Verifying it works

```bash
# Check the bridge is reachable and shows your device count
curl http://<bridge-ip>:3000/health
# → {"ok":true,"devices":14}

# Smoke test — lists Ring devices and exits (no Hubitat needed)
cd bridge && npm run smoke
```

---

## Updating

### Bridge (Docker)
```bash
git pull
docker compose -f bridge/docker-compose.yml up -d --build
```
> Always use `--build` when updating — a plain restart uses the old image.

### Hubitat app and drivers
If you installed manually, paste the updated Groovy files into Apps Code / Drivers Code and click Save. If you used HPM, use HPM → **Update** to get the latest versions.

> **Important:** When updating, always refresh **both** the app (`RingIntegrationApp.groovy`) **and** any affected drivers. The app and drivers are versioned together — running a new driver against an old app (or vice versa) can cause device discovery to silently skip new device types.

---

## Troubleshooting

**Alarm hub devices (sensors, locks, lights) not appearing at discovery**
The alarm hub WebSocket connects asynchronously. Wait for the `✔ Ready for Hubitat device discovery` log line before tapping Discover in Hubitat. If you ran discovery too early, just run it again.

**Motion sensors not showing up even after waiting**
The Hubitat app code (`RingIntegrationApp.groovy`) must be up to date — updating drivers alone is not enough. Paste the latest app code into Apps Code and Save, then run discovery again.

**Camera motion not arriving in Hubitat**
Camera events use FCM push by default, which requires outbound TCP to `mtalk.google.com:5228` (and `mobile-gtalk.l.google.com`). Some routers and security suites block this port. If motion never arrives:
- Add `CAMERA_PUSH=false` to `.env` and restart — REST polling (every 20 s) takes over
- Or allow port 5228 outbound to `mtalk.google.com` in your router/firewall

**"OAuth is not enabled for this App" error in Hubitat**
After pasting the app code in Apps Code, click the **OAuth** button at the top of the editor before saving. This one-time step enables the endpoint the bridge posts events to.

**"Could not connect to bridge" in Hubitat during discovery**
- Confirm the bridge is running: `curl http://<bridge-ip>:3000/health`
- Confirm the IP and port in the Hubitat app match your `.env`
- Bridge and Hubitat hub must be on the same LAN segment

**Ring refresh token expired or invalid**
Re-run `npx ring-auth-cli`, paste the new token into `.env` as `RING_REFRESH_TOKEN`, and restart the bridge. After that the bridge handles all future rotations automatically.

**Events stop arriving after bridge restart**
Check that `HUBITAT_EVENT_URL` and `HUBITAT_ACCESS_TOKEN` in `.env` still match the Hubitat app setup page. These values change if you uninstall and reinstall the Ring Integration app on Hubitat.

**Lights or other devices missing after discovery**
Add `LOG_LEVEL=debug` to `.env` and restart. Look for `Device: "..."  type=...  categoryId=...` log lines — every alarm hub device is listed. Any unrecognised device types are logged as `Skipping unsupported alarm device`. Open an issue with the device name and type string.

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
    ├── RingMotionCamera.groovy      cameras and doorbells
    ├── RingContactSensor.groovy     door/window sensors
    ├── RingMotionSensor.groovy      alarm hub PIR motion sensors
    ├── RingAlarmController.groovy   alarm arm/disarm
    ├── RingLock.groovy              door locks
    └── RingSmartLight.groovy        Ring Bridge lights

docs/
└── ring-bridge.service   systemd unit for bare-metal Pi
```

---

## Known limitations

- Ring has no official API — `ring-client-api` may break if Ring updates their backend
- Lock and alarm user attribution adds ~500 ms latency (requires a history API call to identify who triggered the event)
- Camera live video streaming is not supported — only motion and ding events
- The bridge must be on the same LAN as the Hubitat hub; remote/cloud access is out of scope
