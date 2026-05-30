import * as dotenv from 'dotenv';
dotenv.config();

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

export const config = {
  ringRefreshToken:    requireEnv('RING_REFRESH_TOKEN'),
  hubitatEventUrl:     requireEnv('HUBITAT_EVENT_URL'),
  hubitatAccessToken:  requireEnv('HUBITAT_ACCESS_TOKEN'),
  bridgePort:          parseInt(process.env.BRIDGE_PORT ?? '3000', 10),
  logLevel:            (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  tokenFile:           process.env.TOKEN_FILE ?? '/home/node/ring-token.txt',
  alarmControl:        process.env.ALARM_CONTROL !== 'false',
  cameraPush:          process.env.CAMERA_PUSH    !== 'false',
  cameraPolling:       process.env.CAMERA_POLLING !== 'false',
} as const;
