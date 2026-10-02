import fs from 'node:fs';
import process from 'node:process';
import { createPrismaClient, type DatabaseProvider } from '../lib/db.js';
import { assertValidSnapshot, restoreSnapshot, type DatabaseSnapshot } from '../lib/snapshot.js';

/**
 * 快照导入工具（供跨库迁移的**子进程**调用，也可手工使用）。
 *
 * 为什么是子进程：切换数据库时 `prisma generate` 会重新生成 Prisma Client（SQL 方言变了），
 * 而正在运行的服务进程里缓存的是**旧方言**的客户端模块 —— 只有新进程才能加载重新生成的客户端，
 * 把快照写进新库。用法：
 *
 *   node dist/tools/apply-snapshot.js --provider mysql --url "mysql://..." --file snapshot.json
 *
 * stdout 最后一行输出 JSON：{ ok, counts }，父进程据此回填任务进度；失败时 exit 1 并输出原因。
 * 注意 --file 是**未压缩**的 JSON（父进程负责解压到临时文件）。
 */

interface ToolArgs {
  provider: DatabaseProvider;
  url: string;
  file: string;
}

function parseArgs(argv: readonly string[]): ToolArgs {
  const read = (name: string): string => {
    const index = argv.indexOf(`--${name}`);
    const value = index >= 0 ? argv[index + 1] : undefined;
    if (!value) throw new Error(`缺少参数 --${name}`);
    return value;
  };
  const provider = read('provider');
  if (provider !== 'sqlite' && provider !== 'mysql') {
    throw new Error(`不支持的 provider：${provider}（只支持 sqlite / mysql）`);
  }
  return { provider, url: read('url'), file: read('file') };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = fs.readFileSync(args.file, 'utf8');
  const snapshot = JSON.parse(raw) as DatabaseSnapshot;
  assertValidSnapshot(snapshot);

  const client = await createPrismaClient(args.provider, args.url);
  try {
    const { counts } = await restoreSnapshot(client, args.provider, snapshot);
    process.stdout.write(`${JSON.stringify({ ok: true, counts })}\n`);
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exit(1);
});
