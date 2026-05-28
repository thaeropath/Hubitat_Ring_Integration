import express, { Request, Response } from 'express';
import { config } from './config';
import { discoveredDevices, locationStore, lockStore } from './ring/client';
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

app.post('/devices/:id/lock', async (req: Request, res: Response) => {
  const device = lockStore.get(req.params.id);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return; }

  try {
    await (device as unknown as { lock(): Promise<void> }).lock();
    log.info(`Lock command sent to "${device.name}"`);
    res.json({ ok: true });
  } catch (err) {
    log.error(`Lock command failed: ${err}`);
    res.status(500).json({ error: 'Command failed' });
  }
});

app.post('/devices/:id/unlock', async (req: Request, res: Response) => {
  const device = lockStore.get(req.params.id);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return; }

  try {
    await (device as unknown as { unlock(): Promise<void> }).unlock();
    log.info(`Unlock command sent to "${device.name}"`);
    res.json({ ok: true });
  } catch (err) {
    log.error(`Unlock command failed: ${err}`);
    res.status(500).json({ error: 'Command failed' });
  }
});

// ── Alarm commands ────────────────────────────────────────────────────────────

app.post('/devices/:id/arm', async (req: Request, res: Response) => {
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

// ── Start ──────────────────────────────────────────────────────────────────────

export function startServer(): void {
  app.listen(config.bridgePort, () => {
    log.info(`Bridge server listening on port ${config.bridgePort}`);
  });
}
