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

// 显式按包根目录加载 .env，避免受启动时 cwd 影响。
// 打包安装后配置文件放在安装根目录（server 的上一级），因此按顺序尝试两处；
// dotenv 默认不覆盖已存在的变量，所以先匹配到的文件优先生效。
loadEnv({ path: path.join(serverRoot, '.env') });
loadEnv({ path: path.join(serverRoot, '..', '.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** 监听地址：生产环境建议 0.0.0.0（容器/内网访问），本地开发可用 127.0.0.1 */
  HOST: z.string().default('0.0.0.0'),
  DATABASE_PROVIDER: z.enum(['sqlite', 'mysql']).default('sqlite'),
  DATABASE_URL: z.string().min(1).default('file:./prisma/dev.db'),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGIN: z.string().default('*'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),
  /** 新建班级时的默认班级密码（ClassHelper 班级端班级账号登录用），管理员可随时重置 */
  DEFAULT_CLASS_PASSWORD: z.string().min(6).default('123456'),
  /** 新建/重置教师账号时的默认密码（管理员录入教师用） */
  DEFAULT_TEACHER_PASSWORD: z.string().min(6).default('123456'),
  TERM_START_DATE: z.string().default(''),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** 反向代理层数（nginx / 容器场景一般填 1），用于正确识别客户端 IP 与协议 */
  TRUST_PROXY: z.string().default('false'),
  /** Web 管理端构建产物目录；留空则自动探测 ../web-admin/dist 或 ./web */
  WEB_DIST_DIR: z.string().default(''),
  /** 是否启用接口限流（压测时可置 false） */
  RATE_LIMIT_ENABLED: z
    .string()
    .default('true')
    .transform((value) => value !== 'false' && value !== '0'),
  /** 启动时是否校验数据库连通性 */
  STARTUP_DB_CHECK: z
    .string()
    .default('true')
    .transform((value) => value !== 'false' && value !== '0'),
  /** 自动初始化：数据库为空时是否自动执行迁移（安装程序首启动用） */
  AUTO_MIGRATE: z
    .string()
    .default('false')
    .transform((value) => value === 'true' || value === '1'),
  /** 进程 PID 文件（相对路径以 server 根目录为基准），供安装包的启停脚本使用 */
  PID_FILE: z.string().default(''),
  /** 首次初始化（空库）时创建的管理员账号 */
  INITIAL_ADMIN_USERNAME: z.string().min(3).default('admin'),
  INITIAL_ADMIN_PASSWORD: z.string().min(6).default('admin123'),
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

/** 从 file: URL 中取出真实的文件系统路径（供启动前建目录等使用） */
function sqliteFilePathOf(url: string): string {
  const withoutPrefix = url.startsWith('file:') ? url.slice('file:'.length) : url;
  return withoutPrefix.replace(/\\/g, path.sep).replace(/\//g, path.sep);
}

const isSqlite = raw.DATABASE_PROVIDER === 'sqlite';
const isProduction = raw.NODE_ENV === 'production';

const resolvedDatabaseUrl = isSqlite ? resolveSqliteUrl(raw.DATABASE_URL) : raw.DATABASE_URL;
/** SQLite 数据文件的绝对路径（MySQL 时为空字符串），供启动前创建目录使用 */
const sqliteFilePath = isSqlite ? sqliteFilePathOf(resolvedDatabaseUrl) : '';

/** 生产环境配置自检：不安全的默认值直接拒绝启动，避免把开发配置带上生产 */
const INSECURE_SECRET_MARKERS = ['change-me', 'changeme', 'secret', 'classhelper-dev'];
if (isProduction) {
  const problems: string[] = [];
  if (raw.JWT_SECRET.length < 32) problems.push('JWT_SECRET 长度必须 ≥ 32 位');
  if (INSECURE_SECRET_MARKERS.some((marker) => raw.JWT_SECRET.toLowerCase().includes(marker))) {
    problems.push('JWT_SECRET 仍是示例/开发用值，请重新生成');
  }
  if (isSqlite && raw.DATABASE_URL.includes('dev.db')) {
    problems.push('生产环境仍在使用 dev.db，请指定正式的数据文件或改用 MySQL');
  }
  if (problems.length > 0) {
    throw new Error(
      `生产环境（NODE_ENV=production）配置检查未通过：\n${problems.map((item) => `  - ${item}`).join('\n')}\n` +
        '请修改 packages/server/.env 后重试。',
    );
  }

  /**
   * CORS 默认值告警（**不拦截启动**）。
   *
   * `CORS_ORIGIN=*` 与 `credentials: true` 同时开启时，cors 中间件会反射请求方 Origin 并带上
   * `Access-Control-Allow-Credentials: true`。本项目的鉴权走 `Authorization` 头（不是 cookie），
   * 第三方页面拿不到用户的 token，因此实际风险有限；但"允许任意站点带凭据访问"是没有必要的暴露面，
   * 生产部署应填成实际域名。这里只告警：真要卡死会挡住"教室机 file:// 页面直连后端"这类合法部署
   * （那类请求的 Origin 是 `file://`，无法提前枚举），代价不值得。
   */
  if (raw.CORS_ORIGIN.trim() === '*') {
    console.warn(
      '⚠ CORS_ORIGIN=* 且已开启 credentials：生产环境建议改成具体来源（逗号分隔），' +
        '例如 CORS_ORIGIN=https://your-domain.example（教室机 file:// 客户端不受影响）。',
    );
  }
}

/** trust proxy 支持 false / 数字跳数 / loopback 等字符串形式 */
function resolveTrustProxy(value: string): boolean | number | string {
  if (value === 'false' || value === '') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export const env = {
  nodeEnv: raw.NODE_ENV,
  isProduction,
  isDevelopment: raw.NODE_ENV === 'development',
  port: raw.PORT,
  host: raw.HOST,
  databaseProvider: raw.DATABASE_PROVIDER,
  /** 已规范化为绝对路径（SQLite）/ 原始连接串（MySQL） */
  databaseUrl: resolvedDatabaseUrl,
  /** SQLite 数据文件绝对路径（MySQL 时为空） */
  sqliteFilePath,
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
  /** 新建班级时的默认班级密码（班级账号登录） */
  defaultClassPassword: raw.DEFAULT_CLASS_PASSWORD,
  /** 新建/重置教师账号时的初始密码 */
  defaultTeacherPassword: raw.DEFAULT_TEACHER_PASSWORD,
  termStartDate: raw.TERM_START_DATE,
  logLevel: raw.LOG_LEVEL,
  trustProxy: resolveTrustProxy(raw.TRUST_PROXY),
  webDistDir: raw.WEB_DIST_DIR,
  rateLimitEnabled: raw.RATE_LIMIT_ENABLED,
  startupDbCheck: raw.STARTUP_DB_CHECK,
  autoMigrate: raw.AUTO_MIGRATE,
  /** PID 文件的绝对路径（未配置时为空字符串） */
  pidFile: raw.PID_FILE ? path.resolve(serverRoot, raw.PID_FILE) : '',
  initialAdminUsername: raw.INITIAL_ADMIN_USERNAME,
  initialAdminPassword: raw.INITIAL_ADMIN_PASSWORD,
  serverRoot,
} as const;

export type AppEnv = typeof env;
