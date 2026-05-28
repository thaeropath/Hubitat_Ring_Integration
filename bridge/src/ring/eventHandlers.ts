import { RingApi } from 'ring-client-api';
import { sendEvent } from '../hubitat/client';
import { log } from '../logger';

type RingLocation = Awaited<ReturnType<RingApi['getLocations']>>[number];
type RingCamera   = Awaited<ReturnType<RingLocation['getCameras']>>[number];
type RingDevice   = Awaited<ReturnType<RingLocation['getDevices']>>[number];

const HISTORY_DELAY_MS = 500;

// ── Alarm ─────────────────────────────────────────────────────────────────────

const ALARM_MODE_MAP: Record<string, string> = {
  all:  'armed-away',
  some: 'armed-home',
  none: 'disarmed',
};

export async function handleAlarmMode(location: RingLocation, mode: string): Promise<void> {
  const value = ALARM_MODE_MAP[mode] ?? mode;

  // Brief pause so Ring history records the event before we query it
  await delay(HISTORY_DELAY_MS);
  const lastUser = await resolveAlarmUser(location, mode);

  await sendEvent({ deviceId: location.id, type: 'alarm', value, lastUser });
  log.info(`Alarm "${location.name}" → ${value}${lastUser ? ` (${lastUser})` : ''}`);
}

async function resolveAlarmUser(location: RingLocation, mode: string): Promise<string | undefined> {
  try {
    const history = await location.getHistory({ limit: 5 });
    for (const entry of history) {
      const ctx = (entry as { context?: Record<string, string> }).context;
      if (!ctx) continue;
      const name = ctx.userName ?? ctx.agentName;
      if (name) return name;
    }
  } catch (err) {
    log.warn(`Could not fetch alarm history for user attribution: ${err}`);
  }
  return undefined;
}

// ── Camera / Doorbell ─────────────────────────────────────────────────────────

export async function handleMotion(camera: RingCamera, active: boolean): Promise<void> {
  const value = active ? 'active' : 'inactive';
  await sendEvent({ deviceId: camera.id.toString(), type: 'motion', value });
  log.info(`Motion "${camera.name}" → ${value}`);
}

export async function handleDing(camera: RingCamera): Promise<void> {
  await sendEvent({ deviceId: camera.id.toString(), type: 'ding', value: 'pushed' });
  log.info(`Ding "${camera.name}"`);
}

// ── Contact sensor ─────────────────────────────────────────────────────────────

export async function handleContact(device: RingDevice, faulted: boolean): Promise<void> {
  const value = faulted ? 'open' : 'closed';
  await sendEvent({ deviceId: device.id.toString(), type: 'contact', value });
  log.info(`Contact "${device.name}" → ${value}`);
}

// ── Lock ──────────────────────────────────────────────────────────────────────

export async function handleLockData(
  device: RingDevice,
  locked: 'locked' | 'unlocked',
  location: RingLocation,
): Promise<void> {
  await delay(HISTORY_DELAY_MS);
  const lastUser = await resolveLockUser(location, locked);

  await sendEvent({ deviceId: device.id.toString(), type: 'lock', value: locked, lastUser });
  log.info(`Lock "${device.name}" → ${locked}${lastUser ? ` (${lastUser})` : ''}`);
}

async function resolveLockUser(location: RingLocation, _state: string): Promise<string | undefined> {
  try {
    const history = await location.getHistory({ limit: 5 });
    for (const entry of history) {
      const ctx = (entry as { context?: Record<string, string> }).context;
      if (!ctx) continue;
      const name = ctx.userName ?? ctx.agentName;
      if (name) return name;
    }
  } catch (err) {
    log.warn(`Could not fetch lock history for user attribution: ${err}`);
  }
  return undefined;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
