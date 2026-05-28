# Hubitat Ring Integration — Project Instructions

## Purpose

Bridge Ring security devices (cameras, contact sensors, alarm system, door locks) to a Hubitat Elevation hub. The hub can then trigger automations based on Ring events and send commands back to Ring devices.

### Supported devices and events

| Ring Device | Events into Hubitat | Commands from Hubitat |
|---|---|---|
| Camera / Doorbell | motion active/inactive, ding | — |
| Contact sensor | open / closed | — |
| Ring Alarm | armed-away, armed-home, disarmed + which user triggered | arm-away, arm-home, disarm |
| Door lock | locked, unlocked + which user/code triggered | lock, unlock |

---

## Architecture

```
Ring Cloud  ←──── ring-client-api (WebSocket) ────→  Bridge Server (Node.js/TypeScript)
                                                              │          ▲
                                                  events via  │          │  commands via
                                                  HTTP POST   │          │  HTTP POST
                                                              ▼          │
                                                       Hubitat Hub (local LAN)
                                                              │
                                                   ┌──────────┴──────────┐
                                              Hubitat App           Hubitat Drivers
                                         (RingIntegrationApp)    (one per device type)
```

### How Ring events reach the bridge (no polling)

Ring pushes events to connected clients over WebSocket — the same channel the Ring mobile app uses for instant notifications. The `ring-client-api` library speaks this protocol, so the bridge holds a persistent WebSocket connection to Ring's cloud and receives all events in real time:

| Event | ring-client-api subscription | Latency |
|---|---|---|
| Camera / doorbell motion | `camera.onMotionDetected` | real-time push |
| Doorbell press (ding) | `camera.onDoorbellPressed` | real-time push |
| Contact sensor open/close | `sensor.onData` (faulted field) | real-time push |
| Alarm arm/disarm | `location.onAlarmMode` | real-time push |
| Lock locked/unlocked | `lock.onData` (locked field) | real-time push |
| User attribution | `location.getHistory()` REST call after event | +~500 ms |

No polling is required. The only follow-up REST call is the history lookup needed to identify *who* armed/disarmed or locked/unlocked, since the WebSocket payload does not include user context.

The reason the existing Groovy-only "Unofficial Ring Integration" has to poll is that Hubitat's Groovy runtime has no WebSocket support. Our Node.js bridge sidesteps that entirely.

### Bridge server responsibilities

1. Authenticate with Ring (OAuth 2FA token, stored in `~/.ring-token.json`)
2. Maintain a persistent WebSocket connection to Ring via `ring-client-api`; re-subscribe with exponential backoff on disconnect
3. On each Ring event, POST to the Hubitat app's own HTTP endpoint to update the matching child device
4. Expose an HTTP API so Hubitat drivers can send commands (arm/disarm, lock/unlock) back to Ring
5. Serve a `/devices` endpoint listing all discovered Ring devices (used during Hubitat app setup)

### Hubitat side responsibilities

1. **App** (`RingIntegrationApp.groovy`): Install wizard that prompts for bridge IP/port, discovers Ring devices via the bridge `/devices` endpoint, creates a child virtual device for each. Exposes its own HTTP endpoint (via Groovy `mappings {}`) that the bridge POSTs events to — **no Maker API required**.
2. **Drivers** (one `.groovy` per device type): Declare the right Hubitat capabilities, receive attribute updates parsed by the app, and POST command calls to the bridge HTTP API.

### Why not Maker API

Hubitat's Maker API is a generic external-control interface for devices that already exist on the hub. It would require the user to install it separately, manually expose devices, and copy app IDs and tokens. Our custom `RingIntegrationApp.groovy` uses Hubitat's built-in `mappings {}` feature to expose its own endpoints instead — the app generates its own access token and presents the full endpoint URL to the user during setup. This reduces the user-facing setup to two steps: install the app, paste the URL into the bridge `.env`.

---

## Repository Structure

```
Hubitat_Ring_Integration/
├── CLAUDE.md                         ← this file
├── README.md
├── bridge/                           ← Node.js bridge server
│   ├── src/
│   │   ├── index.ts                  ← entry point (loads config, starts server + Ring client)
│   │   ├── config.ts                 ← loads .env, validates required vars
│   │   ├── ring/
│   │   │   ├── client.ts             ← ring-client-api wrapper, auth, reconnect logic
│   │   │   ├── devices.ts            ← Ring device type definitions and normalisation
│   │   │   └── eventHandlers.ts      ← per-event-type handlers that call Hubitat
│   │   ├── hubitat/
│   │   │   ├── makerApi.ts           ← HTTP client for Hubitat Maker API
│   │   │   └── deviceMap.ts          ← maps Ring device IDs → Hubitat virtual device IDs
│   │   └── server.ts                 ← Express HTTP server (Hubitat → Bridge commands)
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
├── hubitat/
│   ├── apps/
│   │   └── RingIntegrationApp.groovy ← parent app + install wizard
│   └── drivers/
│       ├── RingMotionCamera.groovy   ← capability: MotionSensor, capability: VideoCamera
│       ├── RingContactSensor.groovy  ← capability: ContactSensor
│       ├── RingAlarmController.groovy← capability: SecurityKeypad, custom attr: lastUser
│       └── RingLock.groovy           ← capability: Lock, capability: LockCodes
└── docs/
    ├── setup.md                      ← end-user installation guide
    └── architecture.md               ← deeper design notes
```

---

## Technology Stack

| Layer | Technology | Notes |
|---|---|---|
| Bridge server language | TypeScript / Node.js 20 LTS | |
| Ring API client | `ring-client-api` npm package | WebSocket + REST, unofficial |
| Bridge HTTP framework | Express 4 | minimal, no framework magic |
| Hubitat language | Groovy (Hubitat DSL) | runs on-hub, no external runtime |
| Hubitat ↔ Bridge protocol | HTTP REST (JSON) | LAN only; bridge must be on same LAN segment as hub |

---

## Key External APIs

### ring-client-api

```typescript
import { RingApi } from 'ring-client-api';
const ring = new RingApi({ refreshToken: process.env.RING_REFRESH_TOKEN });
const locations = await ring.getLocations();
// Camera motion:
camera.onMotionDetected.subscribe(motion => { /* motion = true/false */ });
// Contact sensor:
sensor.onData.subscribe(data => { /* data.faulted = true/false */ });
// Alarm mode:
location.onAlarmMode.subscribe(mode => { /* mode: 'all' | 'some' | 'none' */ });
// Alarm history (includes user info):
const history = await location.getHistory({ limit: 1 });
// Locks:
lock.onData.subscribe(data => { /* data.locked = 'locked' | 'unlocked' */ });
lock.lock(); lock.unlock();
```

Ring alarm mode values → Hubitat mapping:
- `'all'` → armed-away
- `'some'` → armed-home  
- `'none'` → disarmed

### Hubitat custom app HTTP endpoint

`RingIntegrationApp.groovy` declares a `mappings {}` block exposing:

```
POST http://<HUBITAT_IP>/apps/api/<RING_APP_ID>/ring/event?access_token=<TOKEN>
```

The bridge POSTs Ring events to this URL. Payload:
```json
{
  "deviceId": "ring-device-id-123",
  "type": "motion",
  "value": "active",
  "lastUser": "Jane Smith"
}
```

The app also exposes:
```
GET  /ring/devices     → triggers bridge to refresh device list (called during setup)
POST /ring/command     → (future) hub-initiated commands if needed
```

The Groovy app generates its own `access_token` (a UUID stored in app state) on first install and displays the full endpoint URL to the user in the setup page. No Maker API installation required.

---

## Hubitat Driver Capability Reference

Use these exact capability names in Groovy driver metadata:

| Capability | Key attributes | Key commands |
|---|---|---|
| `MotionSensor` | `motion` (active/inactive) | — |
| `ContactSensor` | `contact` (open/closed) | — |
| `Lock` | `lock` (locked/unlocked) | `lock()`, `unlock()` |
| `LockCodes` | `lockCodes` (JSON map of code→name) | `setCode()`, `deleteCode()`, `getCodes()` |
| `SecurityKeypad` | `securityKeypad` (armed away/home/disarmed) | `armAway()`, `armHome()`, `disarm()` |

Custom attributes (declare in driver metadata):
- `lastUser` (string) — name of user who triggered last event
- `lastEvent` (string) — free-text description of last event

---

## Development Workflow

### First-time setup

```bash
# Bridge server
cd bridge
npm install
cp .env.example .env
# Edit .env with your Ring refresh token and Hubitat details
npm run dev          # ts-node-dev with hot reload

# Get a Ring refresh token (one-time, interactive):
npx ring-auth-cli   # follow 2FA prompts, copies token to stdout
```

### Running in production

```bash
cd bridge
npm run build        # tsc → dist/
npm start            # node dist/index.js
# Or use the provided systemd unit file: docs/ring-bridge.service
```

### Hubitat driver/app installation

1. In Hubitat UI → Drivers Code → New Driver → paste contents of each `.groovy` file
2. In Hubitat UI → Apps Code → New App → paste `RingIntegrationApp.groovy`
3. In Hubitat UI → Apps → Add User App → Ring Integration

### Testing

```bash
cd bridge
npm test             # Jest unit tests
npm run test:watch   # watch mode

# Integration smoke test (requires .env populated):
npm run smoke        # runs src/smoke.ts — lists Ring devices and exits
```

---

## Environment Variables

Documented in `bridge/.env.example`. Required:

| Variable | Description |
|---|---|
| `RING_REFRESH_TOKEN` | OAuth refresh token from `npx ring-auth-cli` |
| `HUBITAT_EVENT_URL` | Full URL of the Hubitat app event endpoint (shown in app setup page) |
| `HUBITAT_ACCESS_TOKEN` | Access token generated by the Hubitat app on first install |
| `BRIDGE_PORT` | Port for this bridge server (default: 3000) |

Optional:

| Variable | Description |
|---|---|
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` (default: `info`) |

---

## Coding Conventions

- TypeScript strict mode (`"strict": true` in tsconfig)
- No `any` — use proper Ring SDK types or define local interfaces
- All Ring event subscriptions must handle reconnect: if the Ring WebSocket drops, re-subscribe after exponential backoff (max 5 retries, then alert via log)
- Bridge → Hubitat HTTP calls: retry once on network error, then log and continue (never block the event loop)
- Groovy drivers: keep all network calls in `asynchttpGet`/`asynchttpPost` — never synchronous HTTP in a driver
- Each Groovy driver file must declare `author`, `version`, and `description` in its definition block
- Version Groovy files as `1.0.0`, incrementing patch for bug fixes, minor for new attributes/commands

---

## Ring Alarm User Attribution

Ring's alarm history API returns an event log with user names. The bridge should:

1. On each alarm mode change event, immediately call `location.getHistory({ limit: 5 })` 
2. Find the most recent entry matching the new mode (armed/disarmed)
3. Extract `context.userType` + `context.userName` (or `context.agentName` for third-party)
4. Include `lastUser` in the Hubitat attribute update payload

Lock user attribution follows a similar pattern via `location.getHistory()` filtering for lock events.

---

## Known Limitations / Constraints

- Ring has no official API — `ring-client-api` may break when Ring updates their backend
- Lock user attribution requires a history API call after each event (adds ~500 ms latency)
- Ring cameras do not support live video streaming through this integration (only motion events)
- The bridge must be on the same LAN as the Hubitat hub; remote access is out of scope
- Ring 2FA is required on first auth; the refresh token persists until revoked or expired (~1 year)
