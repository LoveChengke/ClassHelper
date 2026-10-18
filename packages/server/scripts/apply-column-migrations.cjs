/**
 * 维护脚本：给"已有数据库"补齐结构性新增列（不依赖安装程序升级）。
 *
 * 服务端启动时会自动应用完整迁移。本脚本仅用于排查旧库缺列，
 * 不能替代正式迁移（例如移除联动表、创建权限组索引）。
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
    table: 'Courseware',
    column: 'archivePath',
    sql: `ALTER TABLE "Courseware" ADD COLUMN "archivePath" TEXT NOT NULL DEFAULT ''`,
    note: '上传日期归档路径',
  },
  {
    table: 'Courseware',
    column: 'folderPath',
    sql: `ALTER TABLE "Courseware" ADD COLUMN "folderPath" TEXT NOT NULL DEFAULT ''`,
    note: '自建分类目录',
  },
  {
    table: 'ClientDevice',
    column: 'updateProgress',
    sql: `ALTER TABLE "ClientDevice" ADD COLUMN "updateProgress" TEXT NOT NULL DEFAULT ''`,
    note: '设备更新进度',
  },
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
  {
    table: 'Class',
    column: 'studentGradeQueryEnabled',
    sql: `ALTER TABLE "Class" ADD COLUMN "studentGradeQueryEnabled" BOOLEAN NOT NULL DEFAULT true`,
    note: 'ClassHelper 班级端按学号查成绩的开关（默认开启）',
  },
  {
    table: 'Grade',
    column: 'levelType',
    sql: `ALTER TABLE "Grade" ADD COLUMN "levelType" TEXT NOT NULL DEFAULT 'percent'`,
    note: '成绩等级口径：percent / letter / custom',
  },
  {
    table: 'Grade',
    column: 'level',
    sql: `ALTER TABLE "Grade" ADD COLUMN "level" TEXT NOT NULL DEFAULT ''`,
    note: '成绩等级文本（percent 下由得分率换算，可手改）',
  },
  {
    table: 'User',
    column: 'phone',
    sql: `ALTER TABLE "User" ADD COLUMN "phone" TEXT NOT NULL DEFAULT ''`,
    note: '教师手机号',
  },
  {
    table: 'User',
    column: 'careMode',
    sql: `ALTER TABLE "User" ADD COLUMN "careMode" BOOLEAN NOT NULL DEFAULT false`,
    note: '关怀模式（大字版界面）',
  },
  {
    table: 'Notification',
    column: 'assignDate',
    sql: `ALTER TABLE "Notification" ADD COLUMN "assignDate" TEXT NOT NULL DEFAULT ''`,
    note: '通知所属日期（本地日期 YYYY-MM-DD，按天归档用）',
  },
];

/**
 * ⚠ 本脚本只能补**新增的列**，补不了结构变化。
 *
 * 2026-10-06 那版「学生从账号变成名单记录」（`prisma/migrations/20261006120000_add_student_table`）
 * 是一次真正的表重构：新建 `Student` / `StudentClassTransfer`、把 `Grade`/`HomeworkStatus`/
 * `NotificationRead` 的外键从 `userId` 换到 `studentId`、删掉 `Enrollment` 与 `ClassTeacher`。
 * 这些**必须走正式的迁移链路**（`prisma migrate deploy`，安装程序升级时自动执行）：
 *
 *   node apply-column-migrations.cjs "<安装目录>/server/dist/lib/db.js"   # 只补列
 *   pnpm --filter @classhelper/server db:deploy                          # 结构变化走这条
 *
 * 只跑本脚本、不跑迁移的库会停在"列有了但表没换"的中间态 —— 下面的列已经能把
 * 界面撑起来不报错，但学生数据仍留在 `User` 里，属于不可用状态。
 */

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
