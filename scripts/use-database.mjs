#!/usr/bin/env node
/**
 * 数据库 provider 切换助手：node scripts/use-database.mjs <sqlite|mysql>
 *
 * 只做一件事：把 packages/server/prisma/schema.prisma 里的 datasource provider
 * 改成目标值（其余字段、模型定义完全不动），并打印后续必须执行的步骤。
 * 详细说明见 docs/mysql.md。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED = ['sqlite', 'mysql'];
const target = (process.argv[2] ?? '').toLowerCase();

if (!SUPPORTED.includes(target)) {
  console.error(`用法：node scripts/use-database.mjs <${SUPPORTED.join('|')}>`);
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = path.join(repoRoot, 'packages/server/prisma/schema.prisma');
const schema = readFileSync(schemaPath, 'utf8');

const matched = /provider\s*=\s*"(sqlite|mysql)"/.exec(schema);
const current = matched?.[1];

if (current === target) {
  console.log(`prisma/schema.prisma 的 provider 已经是 "${target}"，无需修改。`);
} else if (!current) {
  console.error('未能在 prisma/schema.prisma 的 datasource 中找到 provider 配置。');
  process.exit(1);
} else {
  writeFileSync(schemaPath, schema.replace(/provider\s*=\s*"(sqlite|mysql)"/, `provider = "${target}"`));
  console.log(`已将 datasource provider 从 "${current}" 切换为 "${target}"。`);
}

if (target === 'mysql') {
  console.log(`
后续步骤：
  1) 安装 MySQL 驱动适配器
       pnpm --filter @classhelper/server add @prisma/adapter-mariadb
  2) 修改 packages/server/.env
       DATABASE_PROVIDER=mysql
       DATABASE_URL="mysql://user:password@host:3306/classhelper"
  3) 重新生成迁移（SQLite 的迁移是方言相关的，必须重建）
       rm -rf packages/server/prisma/migrations
       pnpm db:migrate
  4) 初始化数据
       pnpm db:seed

详见 docs/mysql.md`);
} else {
  console.log(`
后续步骤：
  1) 修改 packages/server/.env
       DATABASE_PROVIDER=sqlite
       DATABASE_URL="file:./prisma/dev.db"
  2) 若之前使用过 MySQL 迁移，先删除方言迁移目录并重建
       rm -rf packages/server/prisma/migrations
       pnpm db:migrate
  3) 初始化数据
       pnpm db:seed`);
}
