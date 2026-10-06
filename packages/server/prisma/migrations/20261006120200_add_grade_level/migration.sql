-- 成绩等级：落到库里，教师可单个/批量手动编辑
--
-- 在此之前等级是**前端按得分率现算**的（`@classhelper/shared` 的 `gradeLevel(percent)`），
-- 教师既看不到存下来的等级，也无法手动调整 —— 而需求要求
-- 「发布成绩时可选百分制 / 等级制 A·B·C·D / 自定义等级，且可手动编辑等级（单个 + 批量）」。
--
-- `levelType`：
--   percent 百分制 —— 等级由得分率自动换算（教师仍可手改并覆盖）
--   letter  等级制 —— 直接给 A / B / C / D
--   custom  自定义等级 —— 教师填任意文本（优 / 良 / 合格 / 待提高…）
--
-- `level` 永远有值：percent 下写入换算结果，其余两种按教师指定写入。
ALTER TABLE "Grade" ADD COLUMN "levelType" TEXT NOT NULL DEFAULT 'percent';
ALTER TABLE "Grade" ADD COLUMN "level" TEXT NOT NULL DEFAULT '';

-- 回填旧数据：按升级前的同一套口径（得分率 ≥90 A / ≥80 B / ≥70 C / ≥60 D / 其余 E）算，
-- 保证升级前后界面上看到的等级完全一致。总分非法（≤0）一律落到 E。
UPDATE "Grade"
SET "level" = CASE
    WHEN "totalScore" > 0 AND ("score" * 100.0 / "totalScore") >= 90 THEN 'A'
    WHEN "totalScore" > 0 AND ("score" * 100.0 / "totalScore") >= 80 THEN 'B'
    WHEN "totalScore" > 0 AND ("score" * 100.0 / "totalScore") >= 70 THEN 'C'
    WHEN "totalScore" > 0 AND ("score" * 100.0 / "totalScore") >= 60 THEN 'D'
    ELSE 'E'
  END
WHERE "level" = '';
