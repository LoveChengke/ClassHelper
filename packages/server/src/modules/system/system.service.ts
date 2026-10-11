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
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
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
const RUN_KEY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_KEY_NAME = 'ClassHelperServer';
const SYSTEMD_UNIT = 'classhelper';

function runCommand(file: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, output: output || (result.error ? result.error.message : '') };
}

/** 安装器写在安装目录里的启动脚本：它存在才算"装好的形态" */
function startCmdPath(): string {
  return path.join(path.dirname(process.execPath), 'start.cmd');
}

export async function getSystemSettings(): Promise<SystemSettingsDto> {
  return { developerMode: await getBooleanSetting(SETTING_KEYS.developerMode, false) };
}

export async function updateSystemSettings(
  user: TokenPayload,
  input: UpdateSystemSettingsInput,
): Promise<SystemSettingsDto> {
  if (input.developerMode !== undefined) {
    await setBooleanSetting(SETTING_KEYS.developerMode, input.developerMode);
    logger.info(`开发者模式已${input.developerMode ? '开启' : '关闭'}（操作人=${user.username}）`);
  }
  return getSystemSettings();
}

export async function getAutostartStatus(): Promise<AutostartStatusDto> {
  if (process.platform === 'win32') {
    const cmd = startCmdPath();
    if (!fs.existsSync(cmd)) {
      return {
        supported: false,
        enabled: false,
        mechanism: 'unsupported',
        detail: '未检测到安装形态（缺少 start.cmd）：开发环境或免安装目录不提供开机自启切换',
      };
    }
    const query = runCommand('reg.exe', ['query', RUN_KEY_PATH, '/v', RUN_KEY_NAME]);
    return {
      supported: true,
      enabled: query.ok,
      mechanism: 'run-key',
      detail: `注册表 HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\${RUN_KEY_NAME} → "${cmd}"`,
    };
  }

  if (process.platform === 'linux') {
    const unit = `/etc/systemd/system/${SYSTEMD_UNIT}.service`;
    if (!fs.existsSync(unit)) {
      return {
        supported: false,
        enabled: false,
        mechanism: 'unsupported',
        detail: `未找到 ${unit}（不是 systemd 安装形态）`,
      };
    }
    const query = runCommand('systemctl', ['is-enabled', SYSTEMD_UNIT]);
    return {
      supported: true,
      enabled: query.ok,
      mechanism: 'systemd',
      detail: `systemctl is-enabled ${SYSTEMD_UNIT}`,
    };
  }

  return {
    supported: false,
    enabled: false,
    mechanism: 'unsupported',
    detail: `当前平台（${process.platform}）不支持切换开机自启`,
  };
}

export async function updateAutostart(input: UpdateAutostartInput): Promise<AutostartStatusDto> {
  const current = await getAutostartStatus();
  if (!current.supported) throw ApiError.badRequest(current.detail);

  if (current.mechanism === 'run-key') {
    const cmd = startCmdPath();
    const result = input.enabled
      ? runCommand('reg.exe', ['add', RUN_KEY_PATH, '/v', RUN_KEY_NAME, '/t', 'REG_SZ', '/d', `"${cmd}"`, '/f'])
      : runCommand('reg.exe', ['delete', RUN_KEY_PATH, '/v', RUN_KEY_NAME, '/f']);
    if (!result.ok) throw ApiError.internal(`写入开机自启项失败：${result.output}`);
  } else {
    const result = runCommand('systemctl', [input.enabled ? 'enable' : 'disable', SYSTEMD_UNIT]);
    if (!result.ok) {
      throw ApiError.badRequest(
        `systemctl ${input.enabled ? 'enable' : 'disable'} ${SYSTEMD_UNIT} 失败：${result.output}（服务是否以特权用户运行？）`,
      );
    }
  }

  logger.info(`服务端开机自启已${input.enabled ? '开启' : '关闭'}（机制=${current.mechanism}）`);
  return getAutostartStatus();
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
