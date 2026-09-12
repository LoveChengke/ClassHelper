/**
 * Web 管理端 UI 冒烟测试启动器。
 *
 * 复用 desktop-client 里已安装的 Electron 运行时（无需额外依赖），
 * 以「真实浏览器内核 + 真实点击」的方式验证 Web 管理端。
 *
 * 用法：
 *   1) 启动后端（同时托管 Web 管理端）：pnpm dev:server 或生产模式 node dist/index.js
 *   2) pnpm verify:web
 *
 * 环境变量：
 *   UI_SMOKE_URL     默认 http://127.0.0.1:4000/
 *   UI_SMOKE_USER    默认 teacher1
 *   UI_SMOKE_PASS    默认 teacher123
 *   UI_SMOKE_RESULT  结果 JSON 输出路径（可选）
 *   UI_SMOKE_SKIP_PROBE=1  跳过"上课时段探针"（只跑基础 UI 校验）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveElectronEnv, resolveElectronExecutable } from '../lib/electron-env.mjs';
import { cleanupInClassProbe, setupInClassProbe } from './live-probe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronDir = path.join(root, 'packages', 'desktop-client', 'node_modules', 'electron');

if (!fs.existsSync(electronDir)) {
  console.error('[ui-smoke] 未找到 Electron（packages/desktop-client/node_modules/electron）');
  console.error('  请先执行：pnpm install');
  process.exit(2);
}

const executable = resolveElectronExecutable(electronDir);
if (!fs.existsSync(executable)) {
  console.error(`[ui-smoke] Electron 可执行文件不存在：${executable}`);
  console.error('  请执行：node packages/desktop-client/node_modules/electron/install.js');
  process.exit(2);
}

const entry = path.join(root, 'scripts', 'ui-smoke', 'main.cjs');
const target = process.env.UI_SMOKE_URL ?? 'http://127.0.0.1:4000/';
const resultFile = process.env.UI_SMOKE_RESULT ?? path.join(root, '.cache', 'ui-smoke-result.json');
const profileDir = path.join(root, '.cache', 'ui-smoke-profile');

// 每次运行前清空浏览器配置目录，避免 Service Worker / 缓存影响结果
fs.rmSync(profileDir, { recursive: true, force: true });

console.log(`[ui-smoke] 目标：${target}`);
console.log(`[ui-smoke] Electron：${executable}`);

/**
 * 上课时段探针：让服务端真实认定"现在正在上课"，
 * 以便验证「上课时段发布紧急通知 → 全屏警告 + 3 秒倒计时」。
 */
const urgentTitle = `UI 冒烟紧急通知 ${Date.now()}`;
let probe = null;
let probeError = '';

if (process.env.UI_SMOKE_SKIP_PROBE === '1') {
  probeError = '已通过 UI_SMOKE_SKIP_PROBE=1 跳过探针';
  console.log(`[ui-smoke] ${probeError}`);
} else {
  try {
    probe = await setupInClassProbe({
      baseUrl: new URL(target).origin,
      username: process.env.UI_SMOKE_USER ?? 'teacher1',
      password: process.env.UI_SMOKE_PASS ?? 'teacher123',
    });
    if (!probe.inClass) probeError = '探针课表已创建，但服务端仍未判定为上课时段';
    console.log(
      `[ui-smoke] 上课时段探针：班级=${probe.className} 上课中=${probe.inClass} ` +
        `时段=${probe.period ? `${probe.period.startTime}-${probe.period.endTime} · ${probe.period.courseName}` : '-'}`,
    );
  } catch (error) {
    probeError = String(error?.message ?? error);
    console.error(`[ui-smoke] 上课时段探针准备失败：${probeError}`);
    console.error('  "上课时段紧急通知二次确认"校验项将被记为失败。');
  }
}

const child = spawn(executable, [entry], {
  cwd: root,
  stdio: 'inherit',
  env: resolveElectronEnv({
    UI_SMOKE_URL: target,
    UI_SMOKE_RESULT: resultFile,
    UI_SMOKE_PROFILE: profileDir,
    UI_SMOKE_URGENT_TITLE: urgentTitle,
    UI_SMOKE_INCLASS: probe?.inClass ? '1' : '0',
    UI_SMOKE_PROBE_DETAIL: probeError,
  }),
});

child.on('exit', async (code) => {
  if (probe) {
    try {
      const removed = await cleanupInClassProbe(probe, { notificationTitle: urgentTitle });
      console.log(
        removed.length > 0
          ? `[ui-smoke] 探针清理完成：${removed.join(', ')}`
          : '[ui-smoke] 探针清理完成（无残留数据）',
      );
    } catch (error) {
      console.error(`[ui-smoke] 探针清理失败（请手动检查演示数据）：${error?.message ?? error}`);
    }
  }

  if (code === 0) {
    console.log(`[ui-smoke] 全部通过，结果文件：${resultFile}`);
  }
  process.exit(code ?? 1);
});
