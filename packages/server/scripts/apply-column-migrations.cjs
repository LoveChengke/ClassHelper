/**
 * 维护脚本：给"已有数据库"补齐结构性新增列（不依赖安装程序升级）。
 *
 * 为什么需要它：安装版服务端只在**库为空**时执行随包迁移 SQL（首次启动建表）；
 * 用安装程序覆盖升级时，升级逻辑会自动补齐新迁移。若像本地联调那样**手工覆盖 dist**
 * 部署，就需要显式跑一次本脚本。
 *
 * 用法（用安装目录自带的 node 即可，无需 SDK）：传入**已编译的 `lib/db.js`**，
 * 直接复用服务端自己配置好的 Prisma 客户端（Prisma 7 需要 driver adapter，不能裸 new）：
 *
 *   node apply-column-migrations.cjs "<安装目录>/server/dist/lib/db.js"
 *
 * 环境变量（与服务端一致）：
 *   DATABASE_PROVIDER=sqlite
 *   DATABASE_URL="file:<绝对路径>/classhelper.db"
 *
 * 幂等：已存在的列会跳过。
 */
const { pathToFileURL } = require('node:url');

const dbEntry = process.argv[2];
if (!dbEntry) {
  console.error('用法：node apply-column-migrations.cjs <已编译的 lib/db.js 绝对路径>');
  process.exit(2);
}

/** 需要保证存在的列（新增迁移时在这里追加一行） */
const COLUMNS = [
  {
    table: 'Schedule',
    column: 'weekParity',
    sql: `ALTER TABLE "Schedule" ADD COLUMN "weekParity" TEXT NOT NULL DEFAULT 'ALL'`,
    note: '课表单双周（ALL/ODD/EVEN）',
  },
  {
    table: 'Class',
    column: 'termWeeks',
    sql: `ALTER TABLE "Class" ADD COLUMN "termWeeks" INTEGER NOT NULL DEFAULT 20`,
    note: '班级教学周数（班主任可调，默认 20）',
  },
];

(async () => {
  let prisma;
  try {
    const module = await import(pathToFileURL(dbEntry).href);
    prisma = module.prisma ?? module.default?.prisma;
  } catch (error) {
    console.error(
      '[migrate] 无法加载服务端的 Prisma 客户端：',
      error && error.message ? error.message : error,
    );
    process.exitCode = 1;
    return;
  }
  if (!prisma) {
    console.error('[migrate] lib/db.js 里没有导出 prisma');
    process.exitCode = 1;
    return;
  }

  try {
    for (const item of COLUMNS) {
      const columns = await prisma.$queryRawUnsafe(`PRAGMA table_info("${item.table}")`);
      if (columns.some((column) => column.name === item.column)) {
        console.log(`[migrate] ${item.table}.${item.column} 已存在（跳过）`);
        continue;
      }
      await prisma.$executeRawUnsafe(item.sql);
      console.log(`[migrate] 已新增 ${item.table}.${item.column} —— ${item.note}`);
    }
    for (const table of [...new Set(COLUMNS.map((item) => item.table))]) {
      const after = await prisma.$queryRawUnsafe(`PRAGMA table_info("${table}")`);
      console.log(`[migrate] ${table} 列：${after.map((column) => column.name).join(', ')}`);
    }
  } catch (error) {
    console.error('[migrate] 失败：', error && error.message ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect?.();
  }
})();
