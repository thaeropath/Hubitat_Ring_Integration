import { RingApi } from 'ring-client-api';
import { config } from '../config';
import { DeviceInfo } from './devices';
import { handleAlarmMode, handleContact, handleDing, handleLockData, handleMotion } from './eventHandlers';
import { log } from '../logger';

// Infer types from ring-client-api rather than relying on named exports that vary by version
type RingLocation = Awaited<ReturnType<RingApi['getLocations']>>[number];
type RingCamera   = Awaited<ReturnType<RingLocation['getCameras']>>[number];
type RingDevice   = Awaited<ReturnType<RingLocation['getDevices']>>[number];

// Device data shapes we care about (ring-client-api uses dynamic device data objects)
interface ContactData { faulted?: boolean }
interface LockData    { locked?: 'locked' | 'unlocked' }

// Populated on init; used by the HTTP server for /devices and command routing
export const discoveredDevices: DeviceInfo[] = [];
export const locationStore = new Map<string, RingLocation>();
export const lockStore      = new Map<string, RingDevice>();

const MAX_RETRIES = 5;

export async function initRingClient(): Promise<void> {
  const ring = new RingApi({ refreshToken: config.ringRefreshToken });

  // Log if ring rotates our refresh token so the user knows to update .env
  ring.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
    log.warn(`Ring refresh token rotated. Update RING_REFRESH_TOKEN in .env to: ${newRefreshToken}`);
  });

  const locations = await ring.getLocations();
  log.info(`Found ${locations.length} Ring location(s)`);

  for (const location of locations) {
    await subscribeLocation(location);
  }

  log.info(`Subscribed to ${discoveredDevices.length} Ring device(s)`);
}

// ── Location ──────────────────────────────────────────────────────────────────

async function subscribeLocation(location: RingLocation): Promise<void> {
  locationStore.set(location.id, location);

  // One virtual alarm device per location
  discoveredDevices.push({
    id: location.id,
    name: `${location.name} Alarm`,
    type: 'alarm',
    locationId: location.id,
  });

  subscribeWithRetry(
    location.onAlarmMode,
    mode => handleAlarmMode(location, mode),
    `alarm:${location.name}`,
  );

  const [cameras, devices] = await Promise.all([
    location.getCameras(),
    location.getDevices(),
  ]);

  for (const camera of cameras) subscribeCamera(camera, location.id);
  for (const device of devices) subscribeAlarmDevice(device, location);

  log.info(`"${location.name}": ${cameras.length} camera(s), ${devices.length} alarm device(s)`);
}

// ── Camera ────────────────────────────────────────────────────────────────────

function subscribeCamera(camera: RingCamera, locationId: string): void {
  discoveredDevices.push({
    id: camera.id.toString(),
    name: camera.name,
    type: camera.isDoorbell ? 'doorbell' : 'camera',
    locationId,
  });

  subscribeWithRetry(
    camera.onMotionDetected,
    active => handleMotion(camera, active),
    `motion:${camera.name}`,
  );

  if (camera.isDoorbell) {
    subscribeWithRetry(
      camera.onDoorbellPressed,
      () => handleDing(camera),
      `ding:${camera.name}`,
    );
  }
}

// ── Alarm devices (sensors, locks) ───────────────────────────────────────────

function subscribeAlarmDevice(device: RingDevice, location: RingLocation): void {
  const { deviceType } = device;

  if (deviceType === 'sensor.contact') {
    discoveredDevices.push({
      id: device.id.toString(),
      name: device.name,
      type: 'contact-sensor',
      locationId: location.id,
    });

    subscribeWithRetry(
      device.onData,
      (data: ContactData) => {
        if (data.faulted !== undefined) return handleContact(device, data.faulted);
        return Promise.resolve();
      },
      `contact:${device.name}`,
    );
  } else if (deviceType === 'lock') {
    lockStore.set(device.id.toString(), device);
    discoveredDevices.push({
      id: device.id.toString(),
      name: device.name,
      type: 'lock',
      locationId: location.id,
    });

    subscribeWithRetry(
      device.onData,
      (data: LockData) => {
        if (data.locked !== undefined) return handleLockData(device, data.locked, location);
        return Promise.resolve();
      },
      `lock:${device.name}`,
    );
  }
}

// ── Subscription helper with exponential-backoff retry ───────────────────────

function subscribeWithRetry<T>(
  observable: { subscribe: (opts: { next: (v: T) => void; error: (e: unknown) => void }) => void },
  handler: (value: T) => Promise<void>,
  label: string,
  retries = 0,
): void {
  observable.subscribe({
    next: value => {
      handler(value).catch(err => log.error(`Handler error [${label}]: ${err}`));
    },
    error: err => {
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
