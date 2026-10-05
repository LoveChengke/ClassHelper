import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * 服务端版本号。
 *
 * 为什么不再硬编码：`app.ts` 里原本写了两个字面量 `'1.0.0'`（健康检查 + 首页），
 * 而版本号在仓库里已经有 5 份 package.json —— 更新检查要靠它判断"本机是不是旧版"，
 * 再留一份手写副本就一定会漂移。
 *
 * 取哪一份（按顺序）：
 * 1. `serverRoot/..` —— 打包形态下是运行时清单（`scripts/dist-server.mjs` 把**根**
 *    package.json 的 version 写进 `staging/package.json`），也就是产物命名用的那个版本；
 * 2. `serverRoot` —— 开发形态下是 `packages/server/package.json`。
 *
 * 与 `config/env.ts` 加载 `.env` 的双候选写法同一思路：不依赖启动时的 cwd。
 */
function readVersion(): string {
  const candidates = [
    path.resolve(env.serverRoot, '..', 'package.json'),
    path.resolve(env.serverRoot, 'package.json'),
  ];

  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // 换下一个候选
    }
  }

  logger.warn(`未能从 package.json 读到版本号（候选：${candidates.join('、')}），暂时按 0.0.0 处理`);
  return '0.0.0';
}

export const APP_VERSION = readVersion();
