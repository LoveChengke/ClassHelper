/**
 * 定位"真正的 Node 运行时"。
 *
 * 为什么需要它：本机的 `pnpm` 运行在 Electron 内置的 Node 上（宿主终端本身是 Electron 应用，
 * 例如 DSH 桌面端内置终端）。此时 `process.execPath` 指向 **Electron 可执行文件**，
 * 用它去跑 Node CLI 会得到两种典型故障：
 *
 *   1. 没有 `ELECTRON_RUN_AS_NODE=1` 时：Electron 把脚本当成"应用入口"启动，
 *      `process.argv` 里多出一个位置参数 —— 例如 electron-builder 直接报
 *      `Unknown argument: .../electron-builder/out/cli/cli.js`。
 *   2. 有该变量时虽然能跑，但会把 Electron 当成 Node 复制进安装包，
 *      目标机上 `node.exe` 其实是 Electron，服务根本起不来。
 *
 * 因此凡是"需要纯 Node 去执行脚本"的地方（打包 CLI、内置运行时分发），
 * 都用 `resolveNodeRuntime()` 拿一个真实的 node 可执行文件。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 判断候选可执行文件能否以"纯 Node 身份"运行 */
function isNodeRuntime(candidate) {
  const probe = spawnSync(
    candidate,
    ['-e', "process.stdout.write(process.versions.electron ? 'electron' : 'node')"],
    {
      encoding: 'utf8',
      timeout: 20_000,
      // 若候选其实是 Electron，则让它以 Node 模式运行，避免真的弹出应用窗口
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  );
  const kind = String(probe.stdout ?? '').trim();
  return { ok: probe.status === 0 && kind === 'node', kind: kind || probe.error?.message || '未知' };
}

/**
 * 返回 `{ path, version }`；找不到时抛错（附带尝试过的候选，便于排查）。
 * @param {{ extraCandidates?: string[] }} [options]
 */
export function resolveNodeRuntime(options = {}) {
  const candidates = [];
  const push = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  // 1) 显式覆盖（打包机/CI 容易配置）
  push(process.env.CLASSHELPER_NODE_EXE);
  push(process.env.NODE_EXE);

  // 2) 当前进程本身就是 node.exe 时直接复用
  if (path.basename(process.execPath).toLowerCase() === 'node.exe') push(process.execPath);

  for (const candidate of options.extraCandidates ?? []) push(candidate);

  // 3) PATH 中的 node（where node / which node）
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const found = spawnSync(finder, ['node'], { encoding: 'utf8' });
    if (found.status === 0) {
      for (const line of String(found.stdout ?? '').split(/\r?\n/)) push(line.trim());
    }
  } catch {
    /* 忽略：继续尝试常见安装路径 */
  }

  // 4) 常见安装路径
  push(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'));
  push(path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'nodejs', 'node.exe'));
  push(path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'nodejs', 'node.exe'));
  push(path.join(process.env.NVM_SYMLINK ?? '', 'node.exe'));
  push(path.join(process.env.APPDATA ?? '', 'nvm', 'current', 'node.exe'));
  push('D:\\node.js\\node.exe');
  push('/usr/local/bin/node');
  push('/usr/bin/node');

  const rejected = [];
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }

    const verdict = isNodeRuntime(candidate);
    if (verdict.ok) {
      const version = spawnSync(candidate, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? '';
      return { path: candidate, version };
    }
    rejected.push(`${candidate}（${verdict.kind}）`);
  }

  throw new Error(
    '未找到可用的 Node 运行时。\n' +
      `  已尝试：\n  - ${rejected.join('\n  - ') || '（无候选）'}\n` +
      '  请安装 Node.js，或用环境变量 CLASSHELPER_NODE_EXE 指定 node.exe 的完整路径。',
  );
}
