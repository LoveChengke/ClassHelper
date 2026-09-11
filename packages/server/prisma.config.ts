import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 使用 prisma.config.ts 取代了旧的 package.json#prisma 配置块，
 * 并且 datasource 的 url 从 schema.prisma 迁移到这里。
 *
 * 注意：Prisma 7 的生成器不再自动加载 .env，因此这里显式加载
 * packages/server/.env（以 config 文件所在目录为基准，避免依赖 cwd）。
 */
const configDir = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(configDir, '.env') });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // 直接指向 tsx 的入口，避免依赖 shell 的 PATH 里是否有 node_modules/.bin
    seed: 'node ./node_modules/tsx/dist/cli.mjs prisma/seed.ts',
  },
  datasource: {
    // SQLite：file:./prisma/dev.db 会由 src/config/env.ts 解析为绝对路径；
    // MySQL：mysql://user:password@host:3306/classhelper
    url: process.env.DATABASE_URL ?? 'file:./prisma/dev.db',
  },
});
