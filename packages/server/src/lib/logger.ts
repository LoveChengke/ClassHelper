import { env } from '../config/env.js';

const LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVEL_WEIGHT;

function write(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[env.logLevel]) return;
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta === undefined) sink(line);
  else sink(line, meta);
}

export const logger = {
  debug: (message: string, meta?: unknown): void => write('debug', message, meta),
  info: (message: string, meta?: unknown): void => write('info', message, meta),
  warn: (message: string, meta?: unknown): void => write('warn', message, meta),
  error: (message: string, meta?: unknown): void => write('error', message, meta),
};
