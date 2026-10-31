import { assertAdmin } from '../../lib/authz/index.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { createAutostartController } from './autostart.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  CLIENT_ONLINE_WINDOW_MS,
  type AutostartStatusDto,
  type SystemDiagnosticsDto,
  type SystemSettingsDto,
} from '@classhelper/shared';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { SETTING_KEYS, getBooleanSetting, setBooleanSetting } from '../../lib/settings.js';
import { APP_VERSION } from '../../lib/version.js';
import type { UpdateAutostartInput, UpdateSystemSettingsInput } from './system.schemas.js';

/**
 * 服务端系统设置：开发者模式、开机自启、运行诊断。
 *
 * 为什么"开机自启"要做成接口而不是只在安装器里勾一下：教室服务器换机器、改过安装目录、
 * 或者管理员当时没勾，事后都得能补 —— 安装器只负责**默认值**，运行期由这里改。
 * 它改的是**操作系统**的东西（注册表 Run 项 / systemd 单元），所以：
 * 1. 只在"装好的形态"里放行（开发机、免安装包、容器里返回 `supported:false`）；
 * 2. 失败原因是运维性质的（权限不足、单元文件不存在），一律带原文回给管理员，不吞成 500。
 */
function runCommand(file: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, output: output || (result.error ? result.error.message : '') };
}

export async function getSystemSettings(): Promise<SystemSettingsDto> {
  return { developerMode: await getBooleanSetting(SETTING_KEYS.developerMode, false) };
}

export async function updateSystemSettings(
  user: TokenPayload,
  input: UpdateSystemSettingsInput,
): Promise<SystemSettingsDto> {
  assertAdmin(user);
  if (input.developerMode !== undefined) {
    await setBooleanSetting(SETTING_KEYS.developerMode, input.developerMode);
    logger.info(`开发者模式已${input.developerMode ? '开启' : '关闭'}（操作人=${user.username}）`);
  }
  return getSystemSettings();
}

const autostart = createAutostartController({
  platform: process.platform,
  root: path.resolve(env.serverRoot, '..'),
  exists: fs.existsSync,
  run: runCommand,
});
export async function getAutostartStatus(): Promise<AutostartStatusDto> {
  return autostart.read();
}
export async function updateAutostart(
  actor: TokenPayload,
  input: UpdateAutostartInput,
): Promise<AutostartStatusDto> {
  assertAdmin(actor);
  return autostart.write(input.enabled);
}

export async function getDiagnostics(): Promise<SystemDiagnosticsDto> {
  const now = Date.now();
  // 延迟 import：registry 会 import 本模块，顶层互相引用在 ESM 下会拿到未初始化的绑定
  const { apiModules } = await import('../registry.js');
  const [clientReleaseCount, onlineClientCount, settings] = await Promise.all([
    prisma.clientRelease.count(),
    prisma.clientDevice.count({
      where: { lastHeartbeatAt: { gt: new Date(now - CLIENT_ONLINE_WINDOW_MS) } },
    }),
    getSystemSettings(),
  ]);

  return {
    version: APP_VERSION,
    nodeVersion: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    uptimeSeconds: Math.round(process.uptime()),
    databaseProvider: env.databaseProvider,
    serverRoot: env.serverRoot,
    dataDir: path.resolve(env.serverRoot, '..', 'data'),
    clientReleaseCount,
    onlineClientCount,
    moduleCount: apiModules.length,
    developerMode: settings.developerMode,
  };
}
