import { type CameraEvent, Location as RingLocation, RingApi, RingCamera, RingDevice, RingDeviceCategory, RingDeviceData, RingDeviceType } from 'ring-client-api';
import type { Observable } from 'rxjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { config } from '../config';
import { DeviceInfo } from './devices';
import { handleAlarmMode, handleContact, handleDing, handleLightLevel, handleLightOn, handleLockData, handleMotion, handleMotionSensor } from './eventHandlers';
import { log } from '../logger';

// Ring Bridge-connected light device types
const LIGHT_DEVICE_TYPES = new Set<RingDeviceType>([
  RingDeviceType.MultiLevelSwitch,
  RingDeviceType.MultiLevelBulb,
  RingDeviceType.BeamsSwitch,
  RingDeviceType.BeamsMultiLevelSwitch,
  RingDeviceType.BeamsLightGroupSwitch,
  RingDeviceType.BeamsTransformerSwitch,
]);

// Populated on init; used by the HTTP server for /devices and command routing
export const discoveredDevices: DeviceInfo[] = [];
export const locationStore = new Map<string, RingLocation>();
export const lockStore      = new Map<string, RingDevice>();
export const lightStore     = new Map<string, RingDevice>();

const MAX_RETRIES = 5;

// ── Refresh token persistence ─────────────────────────────────────────────────
// Ring issues a new refresh token on every auth. We persist it to a file so
// container restarts always start with the latest valid token.

function loadRefreshToken(): string {
  const { tokenFile, ringRefreshToken } = config;
  if (existsSync(tokenFile)) {
    const saved = readFileSync(tokenFile, 'utf8').trim();
    if (saved) {
      log.info(`Loaded refresh token from ${tokenFile}`);
      return saved;
    }
  }
  return ringRefreshToken;
}

function saveRefreshToken(token: string): void {
  const { tokenFile } = config;
  try {
    mkdirSync(path.dirname(tokenFile), { recursive: true });
    writeFileSync(tokenFile, token, 'utf8');
    log.info(`Refresh token saved to ${tokenFile} — container restarts will use this automatically`);
  } catch (err) {
    log.warn(`Could not save refresh token to ${tokenFile}: ${err}`);
    log.warn(`Update RING_REFRESH_TOKEN in .env manually to: ${token}`);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initRingClient(): Promise<void> {
  const ring = new RingApi({ refreshToken: loadRefreshToken() });

  ring.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
    saveRefreshToken(newRefreshToken);
  });

  // Fetch cameras and locations in parallel.
  // ring.getCameras() is the reliable top-level call — location.cameras can be
  // empty if fetchAndBuildLocations() hasn't associated cameras yet.
  const [locations, allCameras] = await Promise.all([
    ring.getLocations(),
    ring.getCameras(),
  ]);

  log.info(`Found ${locations.length} location(s), ${allCameras.length} camera(s)`);

  for (const camera of allCameras) {
    subscribeCamera(camera, camera.data.location_id ?? '');
  }

  for (const location of locations) {
    subscribeLocation(location);
  }

  log.info(`Initial discovery complete — ${discoveredDevices.length} device(s) found so far`);
  log.info(`Alarm/lock/sensor devices load async as the hub WebSocket connects; re-run Hubitat discovery after a few seconds if needed`);
}

// ── Location ──────────────────────────────────────────────────────────────────

function subscribeLocation(location: RingLocation): void {
  locationStore.set(location.id, location);

  discoveredDevices.push({
    id: location.id,
    name: `${location.name} Alarm`,
    type: 'alarm',
    locationId: location.id,
  });

  subscribeAlarmMode(location);

  log.info(`"${location.name}": hasHubs=${location.hasHubs}  hasAlarmBaseStation=${location.hasAlarmBaseStation}`);

  if (!location.hasHubs) {
    log.warn(`"${location.name}": Ring reports no hub at this location — locks, sensors, and lights will not be available`);
    return;
  }

  // Track which device IDs we've already subscribed — onDevices may fire
  // multiple times (initial load, hub reconnects) and getDevices() races it.
  const subscribedIds = new Set<string>();

  const handleDevices = (devices: RingDevice[]): void => {
    if (devices.length === 0) {
      log.debug(`"${location.name}": handleDevices called with empty list — alarm hub not yet connected`);
      return;
    }
    let added = 0;
    for (const device of devices) {
      if (subscribedIds.has(device.id)) continue;
      subscribedIds.add(device.id);
      added++;

      // Log every device so unknown types (e.g. Ring Bridge lights) can be identified
      log.debug(`Device: "${device.name}"  type=${device.deviceType}  categoryId=${device.categoryId}  id=${device.id}`);

      if (LIGHT_DEVICE_TYPES.has(device.deviceType) || device.categoryId === RingDeviceCategory.Lights) {
        subscribeLightDevice(device, location.id);
      } else {
        subscribeAlarmDevice(device, location);
      }
    }
    if (added > 0) {
      log.info(`"${location.name}": loaded ${added} new alarm device(s) (bridge total: ${discoveredDevices.length})`);
    }
  };

  // Log hub connection state changes
  location.onConnected.subscribe(connected => {
    log.info(`"${location.name}": alarm hub WebSocket ${connected ? 'connected' : 'disconnected'}`);
  });

  // onDevices fires when the alarm hub WebSocket connects and sends the device list.
  location.onDevices.subscribe({
    next:  handleDevices,
    error: err => log.error(`onDevices error for "${location.name}": ${err}`),
  });

  // Explicitly open the hub WebSocket connection (ring-client-api may not open it
  // until something requests it). Then also call getDevices() in case it resolves
  // from cache before onDevices fires.
  log.info(`"${location.name}": calling getConnection() to open alarm hub WebSocket...`);
  const connectionTimeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timed out after 30s — check DEBUG=ring logs for details')), 30_000),
  );
  Promise.race([location.getConnection(), connectionTimeout])
    .then(() => {
      log.info(`"${location.name}": getConnection() resolved — requesting device list`);
      return location.getDevices();
    })
    .then(handleDevices)
    .catch(err => log.warn(`"${location.name}": hub connection failed: ${err}`));
}

// ── Alarm mode ────────────────────────────────────────────────────────────────

function subscribeAlarmMode(location: RingLocation): void {
  location.getSecurityPanel()
    .then(panel => {
      let lastMode: string | undefined;
      subscribeWithRetry(
        panel.onData,
        async (data: RingDeviceData) => {
          const mode = data.mode as string | undefined;
          if (mode && mode !== lastMode) {
            lastMode = mode;
            await handleAlarmMode(location, mode);
          }
        },
        `alarm:${location.name}`,
      );
    })
    .catch(() => {
      log.debug(`No security panel at "${location.name}" — skipping alarm subscription`);
    });
}

// ── Camera ────────────────────────────────────────────────────────────────────

function subscribeCamera(camera: RingCamera, locationId: string): void {
  const doorbell = (camera.deviceType as string).includes('doorbell');
  discoveredDevices.push({
    id: camera.id.toString(),
    name: camera.name,
    type: doorbell ? 'doorbell' : 'camera',
    locationId,
  });

  // FCM push subscription (works when Ring cloud push reaches the bridge)
  subscribeWithRetry(
    camera.onMotionDetected,
    active => handleMotion(camera, active),
    `motion:${camera.name}`,
  );

  // REST polling fallback — covers environments where FCM push is blocked
  startCameraMotionPoller(camera);

  if (doorbell) {
    subscribeWithRetry(
      camera.onDoorbellPressed,
      () => handleDing(camera),
      `ding:${camera.name}`,
    );
    startCameraDingPoller(camera);
  }
}

// ── Camera motion/ding REST polling ──────────────────────────────────────────
// ring-client-api v14 delivers camera events via FCM push notifications which
// require outbound TCP to mtalk.google.com:5228. In environments where that
// port is blocked the push channel is silent. As a reliable fallback we poll
// camera.getEvents() (Ring's REST history API) every 20 seconds.

const CAMERA_POLL_MS             = 20_000;
const CAMERA_MOTION_INACTIVE_MS  = 30_000;

const cameraLastMotionId = new Map<number, string>();
const cameraMotionTimers = new Map<number, ReturnType<typeof setTimeout>>();
const cameraLastDingId   = new Map<number, string>();

async function pollCameraMotion(camera: RingCamera): Promise<void> {
  const result = await camera.getEvents({ limit: 5, kind: 'motion' });
  const events: CameraEvent[] = result.events ?? [];
  if (!events.length) return;

  const latest = events[0];
  if (latest.ding_id_str === cameraLastMotionId.get(camera.id)) return;
  cameraLastMotionId.set(camera.id, latest.ding_id_str);

  await handleMotion(camera, true);

  const existing = cameraMotionTimers.get(camera.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    cameraMotionTimers.delete(camera.id);
    await handleMotion(camera, false);
  }, CAMERA_MOTION_INACTIVE_MS);
  cameraMotionTimers.set(camera.id, timer);
}

async function pollCameraDing(camera: RingCamera): Promise<void> {
  const result = await camera.getEvents({ limit: 5, kind: 'ding' });
  const events: CameraEvent[] = result.events ?? [];
  if (!events.length) return;

  const latest = events[0];
  if (latest.ding_id_str === cameraLastDingId.get(camera.id)) return;
  cameraLastDingId.set(camera.id, latest.ding_id_str);

  await handleDing(camera);
}

function startCameraMotionPoller(camera: RingCamera): void {
  camera.getEvents({ limit: 1, kind: 'motion' })
    .then(result => {
      const events: CameraEvent[] = result.events ?? [];
      if (events.length) {
        cameraLastMotionId.set(camera.id, events[0].ding_id_str);
        log.debug(`Camera "${camera.name}": motion poll seeded — last event ${events[0].created_at}`);
      }
    })
    .catch(err => log.warn(`Camera "${camera.name}": motion seed failed: ${err}`));

  setInterval(() => {
    pollCameraMotion(camera).catch(err =>
      log.error(`Motion poll error for "${camera.name}": ${err}`),
    );
  }, CAMERA_POLL_MS);
}

function startCameraDingPoller(camera: RingCamera): void {
  camera.getEvents({ limit: 1, kind: 'ding' })
    .then(result => {
      const events: CameraEvent[] = result.events ?? [];
      if (events.length) {
        cameraLastDingId.set(camera.id, events[0].ding_id_str);
        log.debug(`Camera "${camera.name}": ding poll seeded — last event ${events[0].created_at}`);
      }
    })
    .catch(err => log.warn(`Camera "${camera.name}": ding seed failed: ${err}`));

  setInterval(() => {
    pollCameraDing(camera).catch(err =>
      log.error(`Ding poll error for "${camera.name}": ${err}`),
    );
  }, CAMERA_POLL_MS);
}

// ── Alarm devices (contact sensors, motion sensors, locks) ───────────────────

const MOTION_SENSOR_TYPES = new Set<RingDeviceType>([
  RingDeviceType.MotionSensor,
  RingDeviceType.BeamsMotionSensor,
]);

function subscribeAlarmDevice(device: RingDevice, location: RingLocation): void {
  if (device.deviceType === RingDeviceType.ContactSensor) {
    discoveredDevices.push({
      id: device.id,
      name: device.name,
      type: 'contact-sensor',
      locationId: location.id,
    });

    subscribeWithRetry(
      device.onData,
      async (data: RingDeviceData) => {
        if (data.faulted !== undefined) await handleContact(device, data.faulted);
      },
      `contact:${device.name}`,
    );

  } else if (MOTION_SENSOR_TYPES.has(device.deviceType)) {
    discoveredDevices.push({
      id: device.id,
      name: device.name,
      type: 'motion-sensor',
      locationId: location.id,
    });

    let lastMotionStatus: string | undefined;
    subscribeWithRetry(
      device.onData,
      async (data: RingDeviceData) => {
        const status = data.motionStatus;
        if (status !== undefined && status !== lastMotionStatus) {
          lastMotionStatus = status;
          await handleMotionSensor(device, status);
        }
      },
      `motion-sensor:${device.name}`,
    );

  } else if (device.categoryId === RingDeviceCategory.Locks) {
    lockStore.set(device.id, device);
    discoveredDevices.push({
      id: device.id,
      name: device.name,
      type: 'lock',
      locationId: location.id,
    });

    subscribeWithRetry(
      device.onData,
      async (data: RingDeviceData) => {
        if (data.locked !== undefined) await handleLockData(device, data.locked, location);
      },
      `lock:${device.name}`,
    );
  }
}

// ── Smart Light (Ring Bridge-connected) ───────────────────────────────────────

function subscribeLightDevice(device: RingDevice, locationId: string): void {
  lightStore.set(device.id, device);
  discoveredDevices.push({
    id: device.id,
    name: device.name,
    type: 'light',
    locationId,
  });

  let lastOn: boolean | undefined;
  let lastLevel: number | undefined;

  subscribeWithRetry(
    device.onData,
    async (data: RingDeviceData) => {
      if (data.on !== undefined && data.on !== lastOn) {
        lastOn = data.on;
        await handleLightOn(device, data.on);
      }
      const brightness = data.level ?? data.brightness;
      if (brightness !== undefined && brightness !== lastLevel) {
        lastLevel = brightness;
        await handleLightLevel(device, brightness);
      }
    },
    `light:${device.name}`,
  );
}

// ── Subscription helper with exponential-backoff retry ───────────────────────

function subscribeWithRetry<T>(
  observable: Observable<T>,
  handler: (value: T) => Promise<void>,
  label: string,
  retries = 0,
): void {
  observable.subscribe({
    next: value => {
      handler(value).catch(err => log.error(`Handler error [${label}]: ${err}`));
    },
    error: (err: unknown) => {
      log.error(`Subscription error [${label}]: ${err}`);
      if (retries >= MAX_RETRIES) {
        log.error(`[${label}] max retries (${MAX_RETRIES}) exceeded — no longer receiving events`);
        return;
      }
      const backoffMs = Math.pow(2, retries) * 1_000;
      log.info(`[${label}] retrying in ${backoffMs / 1000}s (attempt ${retries + 1}/${MAX_RETRIES})`);
      setTimeout(
        () => subscribeWithRetry(observable, handler, label, retries + 1),
        backoffMs,
      );
    },
  });
}
