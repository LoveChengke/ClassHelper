-- 课表支持单双周：新增 weekParity（ALL=每周 / ODD=单周 / EVEN=双周）
-- 旧数据默认为 'ALL'，行为与升级前完全一致（向后兼容）。

ALTER TABLE "Schedule" ADD COLUMN "weekParity" TEXT NOT NULL DEFAULT 'ALL';
