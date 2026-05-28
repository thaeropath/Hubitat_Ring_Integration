import axios from 'axios';
import { config } from '../config';
import { HubitatEvent } from '../ring/devices';
import { log } from '../logger';

const TIMEOUT_MS = 5_000;

export async function sendEvent(event: HubitatEvent): Promise<void> {
  const url = `${config.hubitatEventUrl}?access_token=${config.hubitatAccessToken}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await axios.post(url, event, { timeout: TIMEOUT_MS });
      log.debug(`Hubitat ← ${event.type}=${event.value} device=${event.deviceId}`);
      return;
    } catch (err) {
      if (attempt === 2) {
        log.warn(`Failed to deliver event to Hubitat after 2 attempts: ${err}`);
      }
    }
  }
}
