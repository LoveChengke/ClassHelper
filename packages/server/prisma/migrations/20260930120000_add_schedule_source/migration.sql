-- 课表行来源：manual=手工建立（Web 端录入 / JSON 导入）/ classisland=ClassIsland 插件上报同步。
--
-- 用途：插件每次全量上报课表时，只清理「source=classisland 且本次未再上报」的行。
-- 这样"老师在 ClassIsland 里删掉一节"能被真正同步下来（原先 merge 只 upsert，
-- 服务端会永远留着那行幽灵课），同时老师在小助手这边手排的课不受影响。
-- 存量数据默认按 manual 处理（保守：宁可留下也不误删）。
ALTER TABLE "Schedule" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
