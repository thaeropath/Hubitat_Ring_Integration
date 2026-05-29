import { Location as RingLocation, RingCamera, RingDevice } from 'ring-client-api';
import { sendEvent } from '../hubitat/client';
import { log } from '../logger';

const HISTORY_DELAY_MS = 500;

// ── Alarm ─────────────────────────────────────────────────────────────────────

const ALARM_MODE_MAP: Record<string, string> = {
  all:  'armed-away',
  some: 'armed-home',
  none: 'disarmed',
};

export async function handleAlarmMode(location: RingLocation, mode: string): Promise<void> {
  const value = ALARM_MODE_MAP[mode] ?? mode;

  await delay(HISTORY_DELAY_MS);
  const lastUser = await resolveHistoryUser(location);

  await sendEvent({ deviceId: location.id, type: 'alarm', value, lastUser });
  log.info(`Alarm "${location.name}" → ${value}${lastUser ? ` (${lastUser})` : ''}`);
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

// ── Motion sensor (alarm hub PIR) ─────────────────────────────────────────────

export async function handleMotionSensor(device: RingDevice, motionStatus: string): Promise<void> {
  const value = motionStatus === 'faulted' ? 'active' : 'inactive';
  await sendEvent({ deviceId: device.id, type: 'motion', value });
  log.info(`Motion sensor "${device.name}" → ${value}`);
}

// ── Contact sensor ────────────────────────────────────────────────────────────

export async function handleContact(device: RingDevice, faulted: boolean): Promise<void> {
  const value = faulted ? 'open' : 'closed';
  await sendEvent({ deviceId: device.id, type: 'contact', value });
  log.info(`Contact "${device.name}" → ${value}`);
}

// ── Lock ──────────────────────────────────────────────────────────────────────

export async function handleLockData(
  device: RingDevice,
  locked: 'locked' | 'unlocked' | 'jammed' | 'unknown',
  location: RingLocation,
): Promise<void> {
  // jammed and unknown are forwarded as-is; only look up user for actual state changes
  if (locked === 'jammed' || locked === 'unknown') {
    await sendEvent({ deviceId: device.id, type: 'lock', value: locked });
    log.info(`Lock "${device.name}" → ${locked}`);
    return;
  }

  await delay(HISTORY_DELAY_MS);
  const lastUser = await resolveHistoryUser(location);

  await sendEvent({ deviceId: device.id, type: 'lock', value: locked, lastUser });
  log.info(`Lock "${device.name}" → ${locked}${lastUser ? ` (${lastUser})` : ''}`);
}

// ── Smart Light (Ring Bridge-connected) ───────────────────────────────────────

export async function handleLightOn(device: RingDevice, on: boolean): Promise<void> {
  await sendEvent({ deviceId: device.id, type: 'switch', value: on ? 'on' : 'off' });
  log.info(`Light "${device.name}" → ${on ? 'on' : 'off'}`);
}

export async function handleLightLevel(device: RingDevice, level: number): Promise<void> {
  const clamped = Math.min(100, Math.max(0, Math.round(level)));
  await sendEvent({ deviceId: device.id, type: 'level', value: clamped.toString() });
  log.info(`Light "${device.name}" level → ${clamped}%`);
}

// ── Shared user attribution (alarm + lock) ────────────────────────────────────

async function resolveHistoryUser(location: RingLocation): Promise<string | undefined> {
  try {
    const history = await location.getHistory({ limit: 5 });
    for (const entry of history) {
      const ctx = (entry as { context?: Record<string, string> }).context;
      if (!ctx) continue;
      const name = ctx.userName ?? ctx.agentName;
      if (name) return name;
    }
  } catch (err) {
    log.warn(`Could not fetch history for user attribution: ${err}`);
  }
  return undefined;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
