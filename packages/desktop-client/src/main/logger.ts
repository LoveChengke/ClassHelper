/**
 * 主进程日志（控制台输出）。
 * 打包后的 GUI 进程没有可见的控制台，因此关键信息同时通过：
 * - 冒烟验证的 ELECTRON_SMOKE_RESULT 结果文件
 * - 主窗口右上角的连接状态 / 灵动岛状态
 * 对外可见，避免"出了问题却看不到日志"。
 */
function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    console.log(`[${timestamp()}] DEBUG ${message}`, ...args);
  },
  info(message: string, ...args: unknown[]): void {
    console.log(`[${timestamp()}] INFO  ${message}`, ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    console.warn(`[${timestamp()}] WARN  ${message}`, ...args);
  },
  error(message: string, ...args: unknown[]): void {
    console.error(`[${timestamp()}] ERROR ${message}`, ...args);
  },
};
