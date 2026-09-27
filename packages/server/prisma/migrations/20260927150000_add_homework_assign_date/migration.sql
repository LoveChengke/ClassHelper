-- 作业所属日期（YYYY-MM-DD，本地日期）：客户端/Web 的按天查看与日期高亮都用它
ALTER TABLE "Homework" ADD COLUMN "assignDate" TEXT NOT NULL DEFAULT '';

-- 回填历史数据：按 UTC+8 把 createdAt 折算成当天（本产品面向国内教室，服务器在 CST）
UPDATE "Homework" SET "assignDate" = date("createdAt", '+8 hours') WHERE "assignDate" = '';

CREATE INDEX "Homework_classId_assignDate_idx" ON "Homework"("classId", "assignDate");
