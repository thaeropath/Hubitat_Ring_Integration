import { Location as RingLocation, RingApi, RingCamera, RingDevice, RingDeviceCategory, RingDeviceData, RingDeviceType } from 'ring-client-api';
import type { Observable } from 'rxjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { config } from '../config';
import { DeviceInfo } from './devices';
import { handleAlarmMode, handleContact, handleDing, handleLightLevel, handleLightOn, handleLockData, handleMotion } from './eventHandlers';
import { log } from '../logger';

// Route ring-client-api internal logs through our logger so we can see
// the socket.io host, connection errors, and other internal details.
// Use an absolute file path to bypass Node 12+ package exports restrictions.
/* eslint-disable @typescript-eslint/no-require-imports */
const ringLibDir = path.dirname(require.resolve('ring-client-api'));
const { useLogger } = require(path.join(ringLibDir, 'util')) as {
  useLogger: (l: { logInfo: (...a: unknown[]) => void; logError: (...a: unknown[]) => void }) => void;
};
/* eslint-enable @typescript-eslint/no-require-imports */
useLogger({
  logInfo:  (...args) => log.info(`[ring] ${args.join(' ')}`),
  logError: (...args) => log.warn(`[ring] ${args.join(' ')}`),
});

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

  subscribeWithRetry(
    camera.onMotionDetected,
    active => handleMotion(camera, active),
    `motion:${camera.name}`,
  );

  if (doorbell) {
    subscribeWithRetry(
      camera.onDoorbellPressed,
      () => handleDing(camera),
      `ding:${camera.name}`,
    );
  }
}

// ── Alarm devices (contact sensors, locks) ────────────────────────────────────

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
