// Integration smoke test: verifies Ring auth and lists discovered devices.
// Usage: npm run smoke  (requires .env to be populated)
import { initRingClient, discoveredDevices } from './ring/client';

async function smoke(): Promise<void> {
  console.log('Connecting to Ring...');
  await initRingClient();

  console.log(`\nDiscovered ${discoveredDevices.length} Ring device(s):\n`);
  for (const d of discoveredDevices) {
    console.log(`  [${d.type.padEnd(14)}] ${d.name}  (id: ${d.id})`);
  }

  process.exit(0);
}

smoke().catch(err => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
