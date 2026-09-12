-- 班级账号（班级码 + 班级密码）：学生端以「班级」为主体登录
--
-- 说明：
-- 1) code 是新增的必填唯一列。SQLite 无法直接给已有表加 "NOT NULL 且无默认值" 的列，
--    因此先带默认值 '' 加上，再用 rowid 回填一版可用且唯一的班级码，最后建唯一索引。
-- 2) passwordHash 允许为 NULL：尚未设置班级密码的班级不允许班级登录，
--    管理员可在「班级管理」里设置或重置（bcrypt 哈希由服务端生成）。
-- 3) 迁移逐条执行且忽略"已存在"错误，因此本文件重复执行是安全的。

-- AlterTable
ALTER TABLE "Class" ADD COLUMN "code" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Class" ADD COLUMN "passwordHash" TEXT;

-- Backfill：老数据按 rowid 生成 C00001 形式的班级码（管理员可随时改）
UPDATE "Class" SET "code" = 'C' || substr('00000' || CAST(rowid AS TEXT), -5) WHERE "code" = '';

-- CreateIndex
CREATE UNIQUE INDEX "Class_code_key" ON "Class"("code");
