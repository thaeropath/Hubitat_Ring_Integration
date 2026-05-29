import express, { Request, Response } from 'express';
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

// ── Smart Light commands ──────────────────────────────────────────────────────
// sendCommand() is fire-and-forget; state confirmation arrives via onData push.

app.post('/devices/:id/on', (req: Request, res: Response) => {
  const device = lightStore.get(req.params.id);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return; }

  device.sendCommand('set', { on: true });
  log.info(`Light on: "${device.name}"`);
  res.json({ ok: true });
});

app.post('/devices/:id/off', (req: Request, res: Response) => {
  const device = lightStore.get(req.params.id);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return; }

  device.sendCommand('set', { on: false });
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

  device.sendCommand('set', { on: level > 0, level });
  log.info(`Light level ${level}%: "${device.name}"`);
  res.json({ ok: true });
});

// ── Start ──────────────────────────────────────────────────────────────────────

export function startServer(): void {
  app.listen(config.bridgePort, () => {
    log.info(`Bridge server listening on port ${config.bridgePort}`);
  });
}
