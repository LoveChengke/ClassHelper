import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * 主进程日志。
 *
 * 打包后的 GUI 进程没有可见的控制台，所以除了 console 输出，
 * 关键信息还会追加写入 `%APPDATA%/<app>/logs/client.log`（超过 1MB 自动轮转一次），
 * 便于出问题时（例如"灵动岛去哪了"）直接查看日志文件。
 */
const MAX_LOG_BYTES = 1024 * 1024;

let logFile: string | null = null;
let initialized = false;

function timestamp(): string {
  return new Date().toISOString();
}

function ensureLogFile(): string | null {
  if (initialized) return logFile;
  initialized = true;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'client.log');
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) {
      fs.renameSync(logFile, path.join(dir, 'client.log.1'));
    }
  } catch {
    logFile = null;
  }
  return logFile;
}

function write(level: string, message: string, args: unknown[]): void {
  const extra = args.length > 0 ? ` ${args.map((item) => safeStringify(item)).join(' ')}` : '';
  const line = `[${timestamp()}] ${level} ${message}${extra}\n`;
  const file = ensureLogFile();
  if (!file) return;
  try {
    fs.appendFileSync(file, line, 'utf8');
  } catch {
    /* 日志写失败不能影响主流程 */
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    console.log(`[${timestamp()}] DEBUG ${message}`, ...args);
    write('DEBUG', message, args);
  },
  info(message: string, ...args: unknown[]): void {
    console.log(`[${timestamp()}] INFO  ${message}`, ...args);
    write('INFO ', message, args);
  },
  warn(message: string, ...args: unknown[]): void {
    console.warn(`[${timestamp()}] WARN  ${message}`, ...args);
    write('WARN ', message, args);
  },
  error(message: string, ...args: unknown[]): void {
    console.error(`[${timestamp()}] ERROR ${message}`, ...args);
    write('ERROR', message, args);
  },
  /** 当前日志文件路径（设置页/排查时展示） */
  filePath(): string | null {
    return ensureLogFile();
  },
};
