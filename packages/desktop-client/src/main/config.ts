import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { DEFAULT_SERVER_URL } from '@classhelper/shared';
import type { DesktopStoredConfig } from '../types/desktop.js';

interface PersistedConfig {
  serverUrl: string;
  username: string;
  /** 加密后的 token（base64）或明文（当系统不支持加密时） */
  token: string | null;
  tokenEncrypted: boolean;
}

const DEFAULT_CONFIG: PersistedConfig = {
  serverUrl: DEFAULT_SERVER_URL,
  username: '',
  token: null,
  tokenEncrypted: false,
};

function configFilePath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function encryptToken(token: string | null): { token: string | null; tokenEncrypted: boolean } {
  if (!token) return { token: null, tokenEncrypted: false };
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { token: safeStorage.encryptString(token).toString('base64'), tokenEncrypted: true };
    }
  } catch {
    // 某些环境下 DPAPI 不可用，降级为明文存储（仅本地开发场景）
  }
  return { token, tokenEncrypted: false };
}

function decryptToken(raw: PersistedConfig): string | null {
  if (!raw.token) return null;
  if (!raw.tokenEncrypted) return raw.token;
  try {
    return safeStorage.decryptString(Buffer.from(raw.token, 'base64'));
  } catch {
    return null;
  }
}

function readPersisted(): PersistedConfig {
  try {
    const content = fs.readFileSync(configFilePath(), 'utf8');
    const parsed = JSON.parse(content) as Partial<PersistedConfig>;
    return {
      serverUrl:
        typeof parsed.serverUrl === 'string' && parsed.serverUrl
          ? parsed.serverUrl
          : DEFAULT_CONFIG.serverUrl,
      username: typeof parsed.username === 'string' ? parsed.username : '',
      token: typeof parsed.token === 'string' ? parsed.token : null,
      tokenEncrypted: parsed.tokenEncrypted === true,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writePersisted(config: PersistedConfig): void {
  const target = configFilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(config, null, 2), 'utf8');
}

/** 读取配置（token 已解密），供渲染进程使用 */
export function getConfig(): DesktopStoredConfig {
  const persisted = readPersisted();
  return {
    serverUrl: persisted.serverUrl,
    username: persisted.username,
    token: decryptToken(persisted),
  };
}

/** 局部更新配置：只覆盖传入的字段 */
export function saveConfig(patch: Partial<DesktopStoredConfig>): DesktopStoredConfig {
  const persisted = readPersisted();

  if (typeof patch.serverUrl === 'string' && patch.serverUrl.trim()) {
    persisted.serverUrl = patch.serverUrl.trim().replace(/\/+$/, '');
  }
  if (typeof patch.username === 'string') {
    persisted.username = patch.username;
  }
  if (patch.token !== undefined) {
    const encrypted = encryptToken(patch.token);
    persisted.token = encrypted.token;
    persisted.tokenEncrypted = encrypted.tokenEncrypted;
  }

  writePersisted(persisted);
  return getConfig();
}

/** 清空为默认配置（退出登录 / 重置） */
export function clearConfig(): DesktopStoredConfig {
  writePersisted({ ...DEFAULT_CONFIG });
  return getConfig();
}

export function getConfigPath(): string {
  return configFilePath();
}
