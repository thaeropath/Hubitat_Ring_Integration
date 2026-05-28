import { config } from './config';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

function shouldLog(level: Level): boolean {
  return LEVELS[level] >= LEVELS[config.logLevel];
}

function format(level: Level, msg: string): string {
  return `[${new Date().toISOString()}] [${level.toUpperCase().padEnd(5)}] ${msg}`;
}

export const log = {
  debug: (msg: string): void => { if (shouldLog('debug')) console.log(format('debug', msg)); },
  info:  (msg: string): void => { if (shouldLog('info'))  console.log(format('info',  msg)); },
  warn:  (msg: string): void => { if (shouldLog('warn'))  console.warn(format('warn',  msg)); },
  error: (msg: string): void => { if (shouldLog('error')) console.error(format('error', msg)); },
};
