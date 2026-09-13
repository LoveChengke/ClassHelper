-- 班级教学周数（班主任可调）：默认 20 周，旧数据行为不变（原来固定按 20 周展示，见 seed/导入默认值）
ALTER TABLE "Class" ADD COLUMN "termWeeks" INTEGER NOT NULL DEFAULT 20;