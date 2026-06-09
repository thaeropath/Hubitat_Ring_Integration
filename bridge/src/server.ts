import express, { Request, Response } from 'express';
import type { RingDevice } from 'ring-client-api';
import { config } from './config';
import { discoveredDevices, lightStore, locationStore, lockStore } from './ring/client';
import { log } from './logger';

const app = express();
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, devices: discoveredDevices.length });
});

// ── Device discovery (called by Hubitat app during setup) ─────────────────────

app.get('/devices', (_req: Request, res: Response) => {
  res.json(discoveredDevices);
});

// ── Lock commands ─────────────────────────────────────────────────────────────
// sendCommand() is fire-and-forget (returns void); state confirmation arrives
// back via the onData WebSocket push, which triggers handleLockData.

app.post('/devices/:id/lock', (req: Request, res: Response) => {
  const device = lockStore.get(req.params.id);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return; }

  device.sendCommand('lock.set', { mode: 'locked' });
  log.info(`Lock command sent to "${device.name}"`);
  res.json({ ok: true });
});

app.post('/devices/:id/unlock', (req: Request, res: Response) => {
  const device = lockStore.get(req.params.id);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return; }

  device.sendCommand('lock.set', { mode: 'unlocked' });
  log.info(`Unlock command sent to "${device.name}"`);
  res.json({ ok: true });
});

// ── Alarm commands ────────────────────────────────────────────────────────────

app.post('/devices/:id/arm', async (req: Request, res: Response) => {
  if (!config.alarmControl) {
    log.warn('Arm command blocked — ALARM_CONTROL=false (view-only mode)');
    res.status(403).json({ error: 'Alarm control is disabled (ALARM_CONTROL=false)' });
    return;
  }

  const location = locationStore.get(req.params.id);
  if (!location) { res.status(404).json({ error: 'Location not found' }); return; }

  const mode = (req.body as { mode?: string }).mode;
  if (mode !== 'away' && mode !== 'home') {
    res.status(400).json({ error: 'mode must be "away" or "home"' });
    return;
  }

  try {
    await location.setAlarmMode(mode === 'away' ? 'all' : 'some');
    log.info(`Arm ${mode} sent to "${location.name}"`);
    res.json({ ok: true });
  } catch (err) {
    log.error(`Arm command failed: ${err}`);
    res.status(500).json({ error: 'Command failed' });
  }
});

app.post('/devices/:id/disarm', async (req: Request, res: Response) => {
  if (!config.alarmControl) {
    log.warn('Disarm command blocked — ALARM_CONTROL=false (view-only mode)');
    res.status(403).json({ error: 'Alarm control is disabled (ALARM_CONTROL=false)' });
    return;
  }

  const location = locationStore.get(req.params.id);
  if (!location) { res.status(404).json({ error: 'Location not found' }); return; }

  try {
    await location.setAlarmMode('none');
    log.info(`Disarm sent to "${location.name}"`);
    res.json({ ok: true });
  } catch (err) {
    log.error(`Disarm command failed: ${err}`);
    res.status(500).json({ error: 'Command failed' });
  }
});

// ── Smart Light helpers ───────────────────────────────────────────────────────
// Ring Beams/Bridge lights use the 'light-mode.set' alarm hub command.
// Z-wave multi-level switches on the alarm hub use setInfo with device.v1.
// Ring's level field is 0-1 (not 0-100); we convert from Hubitat's 0-100.

function isBeams(device: RingDevice): boolean {
  return (device.deviceType as string).includes('beams');
}

function lightSetOn(device: RingDevice, on: boolean): void {
  if (isBeams(device)) {
    device.sendCommand('light-mode.set', on ? { lightMode: 'on' } : { lightMode: 'default' });
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (device as any).setInfo({ device: { v1: { on } } });
  }
}

function lightSetLevel(device: RingDevice, hubLevel: number): void {
  if (isBeams(device)) {
    device.sendCommand('light-mode.set', { lightMode: hubLevel > 0 ? 'on' : 'default' });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (device as any).setInfo({ device: { v1: { level: hubLevel / 100 } } });
}

// ── Smart Light commands ──────────────────────────────────────────────────────

app.post('/devices/:id/on', (req: Request, res: Response) => {
  const device = lightStore.get(req.params.id);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return; }

  lightSetOn(device, true);
  log.info(`Light on: "${device.name}"`);
  res.json({ ok: true });
});

app.post('/devices/:id/off', (req: Request, res: Response) => {
  const device = lightStore.get(req.params.id);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return; }

  lightSetOn(device, false);
  log.info(`Light off: "${device.name}"`);
  res.json({ ok: true });
});

app.post('/devices/:id/setLevel', (req: Request, res: Response) => {
  const device = lightStore.get(req.params.id);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return; }

  const level = Number((req.body as { level?: unknown }).level);
  if (isNaN(level) || level < 0 || level > 100) {
    res.status(400).json({ error: 'level must be 0-100' });
    return;
  }

  lightSetLevel(device, level);
  log.info(`Light level ${level}%: "${device.name}"`);
  res.json({ ok: true });
});

// ── Start ──────────────────────────────────────────────────────────────────────

export function startServer(): void {
  app.listen(config.bridgePort, () => {
    log.info(`Bridge server listening on port ${config.bridgePort}`);
  });
}
