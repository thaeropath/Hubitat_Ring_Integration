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

### Bridge server responsibilities

1. Authenticate with Ring (OAuth 2FA token, stored in `~/.ring-token.json`)
2. Subscribe to all Ring device events via `ring-client-api` WebSocket
3. On each event, POST to Hubitat's Maker API to update the matching virtual device attribute
4. Expose an HTTP API so Hubitat can send commands (arm/disarm, lock/unlock) back to Ring
5. Serve a `/devices` endpoint listing all discovered Ring devices (used during Hubitat app setup)

### Hubitat side responsibilities

1. **App** (`RingIntegrationApp.groovy`): Install wizard that prompts for bridge IP/port + Maker API token, discovers Ring devices via `/devices`, creates a child virtual device for each
2. **Drivers** (one `.groovy` per device type): Declare the right Hubitat capabilities, handle attribute updates from the bridge, and send command HTTP calls to the bridge

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

### Hubitat Maker API

Base URL: `http://<HUBITAT_IP>/apps/api/<MAKER_APP_ID>`

All requests include `?access_token=<TOKEN>` query param.

```
GET  /devices                        → list all Maker-API-exposed devices
GET  /devices/<id>                   → get device state
GET  /devices/<id>/commands          → list available commands
GET  /devices/<id>/<command>         → send command (e.g. /devices/42/open)
GET  /devices/<id>/<command>/<arg>   → send command with arg (e.g. /devices/42/setLockCode/1)
```

Event push: Hubitat POSTs to a URL you register in the Maker API app UI:
```json
{
  "deviceId": "42",
  "name": "motion",
  "value": "active",
  "displayName": "Front Door Camera",
  "descriptionText": "Front Door Camera motion is active"
}
```

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
| `HUBITAT_IP` | LAN IP of Hubitat hub |
| `HUBITAT_MAKER_APP_ID` | Numeric app ID from Hubitat Maker API |
| `HUBITAT_ACCESS_TOKEN` | Maker API access token |
| `BRIDGE_PORT` | Port for this bridge server (default: 3000) |

Optional:

| Variable | Description |
|---|---|
| `POLL_INTERVAL_MS` | Fallback polling interval if WebSocket drops (default: 30000) |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` (default: `info`) |

---

## Coding Conventions

- TypeScript strict mode (`"strict": true` in tsconfig)
- No `any` — use proper Ring SDK types or define local interfaces
- All Ring event subscriptions must handle reconnect: if the Ring WebSocket drops, re-subscribe after exponential backoff (max 5 retries, then alert via log)
- Hubitat Maker API calls: retry once on network error, then log and continue (never block the event loop)
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
- Hubitat Maker API requires the bridge to be on the same LAN; remote access is out of scope
- Ring 2FA is required on first auth; the refresh token persists until revoked or expired (~1 year)
