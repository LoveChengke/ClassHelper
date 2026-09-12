/**
 * 维护脚本：给"已有数据库"补上 Schedule.weekParity 列（单双周课表）。
 *
 * 为什么需要它：安装版服务端只在**库为空**时执行随包迁移 SQL（首次启动建表）；
 * 用安装程序覆盖升级时，升级逻辑会自动补齐新迁移。若像本地联调那样**手工覆盖 dist**
 * 部署，就需要显式跑一次本脚本。
 *
 * 用法（用安装目录自带的 node 即可，无需 SDK）：传入**已编译的 `lib/db.js`**，
 * 直接复用服务端自己配置好的 Prisma 客户端（Prisma 7 需要 driver adapter，不能裸 new）：
 *
 *   node apply-parity-column.cjs "<安装目录>/server/dist/lib/db.js"
 *
 * 环境变量（与服务端一致）：
 *   DATABASE_PROVIDER=sqlite
 *   DATABASE_URL="file:<绝对路径>/classhelper.db"
 */
const { pathToFileURL } = require('node:url');

const dbEntry = process.argv[2];
if (!dbEntry) {
  console.error('用法：node apply-parity-column.cjs <已编译的 lib/db.js 绝对路径>');
  process.exit(2);
}

(async () => {
  let prisma;
  try {
    const module = await import(pathToFileURL(dbEntry).href);
    prisma = module.prisma ?? module.default?.prisma;
  } catch (error) {
    console.error(
      '[parity] 无法加载服务端的 Prisma 客户端：',
      error && error.message ? error.message : error,
    );
    process.exitCode = 1;
    return;
  }
  if (!prisma) {
    console.error('[parity] lib/db.js 里没有导出 prisma');
    process.exitCode = 1;
    return;
  }

  try {
    const columns = await prisma.$queryRawUnsafe('PRAGMA table_info("Schedule")');
    if (columns.some((column) => column.name === 'weekParity')) {
      console.log('[parity] Schedule.weekParity 已存在，无需处理');
    } else {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "Schedule" ADD COLUMN "weekParity" TEXT NOT NULL DEFAULT 'ALL'`,
      );
      console.log('[parity] 已新增 Schedule.weekParity（默认 ALL，旧数据行为不变）');
    }
    const after = await prisma.$queryRawUnsafe('PRAGMA table_info("Schedule")');
    console.log(`[parity] 当前列：${after.map((column) => column.name).join(', ')}`);
  } catch (error) {
    console.error('[parity] 失败：', error && error.message ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect?.();
  }
})();
