import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { DEFAULT_ISLAND_APPEARANCE, DEFAULT_SERVER_URL, type IslandAppearance } from '@classhelper/shared';
import type { DesktopStoredConfig } from '../types/desktop.js';

interface PersistedConfig {
  serverUrl: string;
  username: string;
  /** 加密后的 token（base64）或明文（当系统不支持加密时） */
  token: string | null;
  tokenEncrypted: boolean;
  /** 个性化设置：灵动岛外观（向后兼容：旧配置文件没有该字段时用默认值补齐） */
  island?: Partial<IslandAppearance>;
}

const DEFAULT_CONFIG: PersistedConfig = {
  serverUrl: DEFAULT_SERVER_URL,
  username: '',
  token: null,
  tokenEncrypted: false,
  island: { ...DEFAULT_ISLAND_APPEARANCE },
};

/** 外观字段的合法区间校验（越界值直接夹紧，避免用户配置破坏灵动岛布局） */
function normalizeIslandAppearance(input?: Partial<IslandAppearance>): IslandAppearance {
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, Math.round(numeric * 100) / 100));
  };
  const positions: IslandAppearance['position'][] = [
    'top-center',
    'top-left',
    'top-right',
    'bottom-center',
    'bottom-left',
    'bottom-right',
  ];
  const styles: IslandAppearance['style'][] = ['black', 'glass', 'tinted'];
  return {
    height: clamp(input?.height, 36, 72, DEFAULT_ISLAND_APPEARANCE.height),
    width: clamp(input?.width, 220, 420, DEFAULT_ISLAND_APPEARANCE.width),
    radius: clamp(input?.radius, 8, 32, DEFAULT_ISLAND_APPEARANCE.radius),
    opacity: clamp(input?.opacity, 0.4, 1, DEFAULT_ISLAND_APPEARANCE.opacity),
    accent:
      typeof input?.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.accent)
        ? input.accent
        : DEFAULT_ISLAND_APPEARANCE.accent,
    fontSize: clamp(input?.fontSize, 11, 20, DEFAULT_ISLAND_APPEARANCE.fontSize),
    animations: input?.animations !== false,
    speed: clamp(input?.speed, 0.5, 2, DEFAULT_ISLAND_APPEARANCE.speed),
    position: positions.includes(input?.position as IslandAppearance['position'])
      ? (input?.position as IslandAppearance['position'])
      : DEFAULT_ISLAND_APPEARANCE.position,
    alwaysOnTop: input?.alwaysOnTop !== false,
    style: styles.includes(input?.style as IslandAppearance['style'])
      ? (input?.style as IslandAppearance['style'])
      : DEFAULT_ISLAND_APPEARANCE.style,
    idleSliver: input?.idleSliver === true,
  };
}

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
      island: normalizeIslandAppearance(parsed.island),
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
    island: normalizeIslandAppearance(persisted.island),
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
  if (patch.island !== undefined) {
    persisted.island = normalizeIslandAppearance({ ...persisted.island, ...patch.island });
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
