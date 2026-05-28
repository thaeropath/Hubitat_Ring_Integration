import { initRingClient } from './ring/client';
import { startServer } from './server';
import { log } from './logger';

async function main(): Promise<void> {
  log.info('Starting Ring-Hubitat bridge...');

  // HTTP server starts immediately so /health responds during Ring auth
  startServer();

  await initRingClient();

  log.info('Bridge ready — listening for Ring events');
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
