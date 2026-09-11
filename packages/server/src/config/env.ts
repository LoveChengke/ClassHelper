import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
/**
 * packages/server 根目录。
 * 源码运行时为 src/config -> ../..；编译后为 dist/config -> ../..，两者一致。
 */
export const serverRoot = path.resolve(currentDir, '..', '..');

// 显式按包根目录加载 .env，避免受启动时 cwd 影响
loadEnv({ path: path.join(serverRoot, '.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_PROVIDER: z.enum(['sqlite', 'mysql']).default('sqlite'),
  DATABASE_URL: z.string().min(1).default('file:./prisma/dev.db'),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGIN: z.string().default('*'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),
  DEFAULT_STUDENT_PASSWORD: z.string().min(6).default('123456'),
  TERM_START_DATE: z.string().default(''),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`环境变量校验失败，请检查 packages/server/.env（可从 .env.example 复制）：\n${issues}`);
}

const raw = parsed.data;

/** 把 file:./prisma/dev.db 解析为绝对路径，保证任何 cwd 下都指向同一个数据库文件 */
function resolveSqliteUrl(url: string): string {
  if (!url.startsWith('file:')) return url;
  const filePath = url.slice('file:'.length);
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(serverRoot, filePath);
  return `file:${absolute.replace(/\\/g, '/')}`;
}

const isSqlite = raw.DATABASE_PROVIDER === 'sqlite';

export const env = {
  nodeEnv: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  port: raw.PORT,
  databaseProvider: raw.DATABASE_PROVIDER,
  /** 已规范化为绝对路径（SQLite）/ 原始连接串（MySQL） */
  databaseUrl: isSqlite ? resolveSqliteUrl(raw.DATABASE_URL) : raw.DATABASE_URL,
  rawDatabaseUrl: raw.DATABASE_URL,
  jwtSecret: raw.JWT_SECRET,
  jwtExpiresIn: raw.JWT_EXPIRES_IN,
  /** true 表示允许所有来源，否则为白名单数组 */
  corsOrigins:
    raw.CORS_ORIGIN === '*'
      ? true
      : raw.CORS_ORIGIN.split(',')
          .map((item) => item.trim())
          .filter(Boolean),
  bcryptRounds: raw.BCRYPT_ROUNDS,
  /** 新增学生时未指定密码时的初始密码 */
  defaultStudentPassword: raw.DEFAULT_STUDENT_PASSWORD,
  termStartDate: raw.TERM_START_DATE,
  logLevel: raw.LOG_LEVEL,
  serverRoot,
} as const;

export type AppEnv = typeof env;
