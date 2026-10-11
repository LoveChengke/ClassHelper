import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * 主进程日志：控制台输出 + 落盘。
 *
 * 打包后的 GUI 进程没有可见的控制台，因此关键信息同时通过：
 * - 冒烟验证的 ELECTRON_SMOKE_RESULT 结果文件
 * - 主窗口右上角的连接状态 / 灵动岛状态
 * - **本文件写出的日志文件**（设置页「打开日志目录」直达）
 * 对外可见，避免"出了问题却看不到日志"。
 *
 * 两条实现约束：
 * 1. `app.getPath('logs')` **不能在 app ready 之前调用**，所以日志文件路径是**懒解析**的：
 *    解析失败（或还没 ready）时只走 console，之后任意一次写入会重新尝试；
 * 2. 单文件超过上限就改名成 `main.log.1`（只留一份旧的，更老的直接删除），
 *    避免长期运行的教室机器把磁盘写满。
 */

/** 单文件大小上限：超过就轮转（1MB 足够放下很多次崩溃堆栈） */
const LOG_MAX_BYTES = 1024 * 1024;
/** 轮转后的旧文件名 */
const LOG_ROTATED_NAME = 'main.log.1';

/** 日志文件名（在 app ready 之后解析；null = 暂不可用） */
let filePath: string | null = null;
/** verbose（= 配置里的 developerMode）时 debug 级别才输出 */
let verbose = false;

/** 解析日志文件路径：失败只返回 null（不抛），调用方继续走 console */
function resolveLogFile(): string | null {
  try {
    return path.join(app.getPath('logs'), 'main.log');
  } catch {
    // app ready 之前调用会抛；此时不写文件即可，控制台输出不受影响
    return null;
  }
}

/** 文件超过上限就轮转：main.log → main.log.1（覆盖上一份旧的） */
function rotateIfNeeded(target: string): void {
  try {
    const stat = fs.statSync(target);
    if (stat.size <= LOG_MAX_BYTES) return;
    const rotated = path.join(path.dirname(target), LOG_ROTATED_NAME);
    // 先删旧的再改名：只保留一份历史日志
    fs.rmSync(rotated, { force: true });
    fs.renameSync(target, rotated);
  } catch {
    // 文件还不存在（第一次写）/ 被占用：都无需处理
  }
}

/** 落盘一行。任何失败都静默忽略 —— 日志不能反过来把主进程搞崩 */
function write(line: string): void {
  if (!filePath) filePath = resolveLogFile();
  const target = filePath;
  if (!target) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${line}\n`, 'utf8');
    rotateIfNeeded(target);
  } catch {
    // 忽略：磁盘满 / 权限不足等都不该影响应用运行
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  /**
   * 设置日志级别（由 `main/index.ts` 按 `config.developerMode` 调用）。
   * 开启后 debug 级别的日志才会同时进控制台与日志文件。
   */
  setVerbose(enabled: boolean): void {
    verbose = enabled === true;
  },
  /** 当前是否 verbose（供设置页/冒烟断言） */
  isVerbose(): boolean {
    return verbose;
  },
  debug(message: string, ...args: unknown[]): void {
    if (!verbose) return;
    const line = `[${timestamp()}] DEBUG ${message}`;
    console.log(line, ...args);
    write(`${line}${formatArgs(args)}`);
  },
  info(message: string, ...args: unknown[]): void {
    const line = `[${timestamp()}] INFO  ${message}`;
    console.log(line, ...args);
    write(`${line}${formatArgs(args)}`);
  },
  warn(message: string, ...args: unknown[]): void {
    const line = `[${timestamp()}] WARN  ${message}`;
    console.warn(line, ...args);
    write(`${line}${formatArgs(args)}`);
  },
  error(message: string, ...args: unknown[]): void {
    const line = `[${timestamp()}] ERROR ${message}`;
    console.error(line, ...args);
    write(`${line}${formatArgs(args)}`);
  },
};

/**
 * 额外参数转成一行文本（落盘用）。
 *
 * 崩溃自愈那边传进来的常常是 Error 对象，**必须把完整堆栈写进文件**，
 * 否则事后再看 `main.log` 只有一个光秃秃的 message，等于没记。
 */
function formatArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  const parts = args.map((item) => {
    if (item instanceof Error) return item.stack ?? `${item.name}: ${item.message}`;
    if (typeof item === 'string') return item;
    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  });
  return ` ${parts.join(' ')}`;
}
