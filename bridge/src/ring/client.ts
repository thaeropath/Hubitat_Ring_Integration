import { Location as RingLocation, RingApi, RingCamera, RingDevice, RingDeviceCategory, RingDeviceData, RingDeviceType } from 'ring-client-api';
import type { Observable } from 'rxjs';
import { config } from '../config';
import { DeviceInfo } from './devices';
import { handleAlarmMode, handleContact, handleDing, handleLightLevel, handleLightOn, handleLockData, handleMotion } from './eventHandlers';
import { log } from '../logger';

// Ring Bridge-connected light device types (Ring Beams and multilevel switches)
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

export async function initRingClient(): Promise<void> {
  const ring = new RingApi({ refreshToken: config.ringRefreshToken });

  ring.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
    log.warn(`Ring refresh token rotated — update RING_REFRESH_TOKEN in .env to: ${newRefreshToken}`);
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

  // One virtual alarm device per location (for arm/disarm control)
  discoveredDevices.push({
    id: location.id,
    name: `${location.name} Alarm`,
    type: 'alarm',
    locationId: location.id,
  });

  // Subscribe to alarm mode via security panel device data
  subscribeAlarmMode(location);

  // cameras is a property (not a method) on Location
  const cameras = location.cameras;
  const devices = await location.getDevices();

  let lights = 0;
  for (const camera of cameras) subscribeCamera(camera, location.id);
  for (const device of devices) {
    if (LIGHT_DEVICE_TYPES.has(device.deviceType) || device.categoryId === RingDeviceCategory.Lights) {
      subscribeLightDevice(device, location.id);
      lights++;
    } else {
      subscribeAlarmDevice(device, location);
    }
  }

  log.info(`"${location.name}": ${cameras.length} camera(s), ${devices.length - lights} alarm device(s), ${lights} light(s)`);
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
