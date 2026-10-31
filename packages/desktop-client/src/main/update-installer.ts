import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

interface InstallerOptions {
  directory: string;
  installer: string;
  version: string;
  sha256: string;
  size: number;
  serverUrl: string;
  username: string;
  restartExe: string;
  portable: boolean;
}

/** 先确认独立助手就绪；调用方复核策略后 commit，再退出应用。 */
export async function prepareUpdateInstaller(options: InstallerOptions) {
  const attempt = crypto.randomUUID();
  const prefix = path.join(options.directory, `install-${attempt}`);
  const helper = path.join(options.directory, `updater-${attempt}.exe`);
  const resultFile = path.join(options.directory, 'install-result.json');
  const logFile = path.join(options.directory, 'install-helper.log');
  fs.mkdirSync(options.directory, { recursive: true });
  for (const name of fs.readdirSync(options.directory)) {
    if (/^updater-[0-9a-f-]{36}\.exe$/i.test(name)) {
      try {
        fs.rmSync(path.join(options.directory, name));
      } catch {
        /* 仍在运行的助手留待下次清理 */
      }
    }
  }
  fs.copyFileSync(path.join(__dirname, 'update-helper.exe'), helper);
  fs.writeFileSync(
    `${prefix}.json`,
    JSON.stringify({
      Attempt: attempt,
      ParentId: process.pid,
      ParentExe: process.execPath,
      Installer: options.installer,
      RestartExe: options.restartExe,
      Version: options.version,
      ServerUrl: options.serverUrl,
      Username: options.username,
      Sha256: options.sha256,
      Size: options.size,
      Portable: options.portable,
    }),
    'utf8',
  );
  fs.rmSync(resultFile, { force: true });
  fs.writeFileSync(logFile, `${new Date().toISOString()} 准备安装 ${options.version}\n`, 'utf8');
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(helper, [`${prefix}.json`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: options.directory,
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error('更新助手就绪超时，请查看 install-helper.log')),
        15_000,
      );
      const poll = setInterval(() => {
        try {
          if (fs.readFileSync(`${prefix}.ready`, 'utf8').trim() === attempt) finish();
        } catch {
          /* 尚未就绪 */
        }
      }, 50);
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null) => {
        let detail = '';
        try {
          detail = JSON.parse(fs.readFileSync(resultFile, 'utf8')).error ?? '';
        } catch {
          /* 原生进程未能启动 */
        }
        finish(new Error(detail || `更新助手提前退出（${code ?? '未知退出码'}），请查看 install-helper.log`));
      };
      function finish(error?: Error) {
        clearTimeout(timeout);
        clearInterval(poll);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        if (error) reject(error);
        else resolve();
      }
      child.once('error', onError);
      child.once('exit', onExit);
    });
    child.unref();
  } catch (error) {
    fs.writeFileSync(`${prefix}.cancel`, attempt, 'utf8');
    throw error;
  }
  return {
    commit: () => fs.writeFileSync(`${prefix}.start`, attempt, 'utf8'),
    cancel: () => fs.writeFileSync(`${prefix}.cancel`, attempt, 'utf8'),
  };
}
