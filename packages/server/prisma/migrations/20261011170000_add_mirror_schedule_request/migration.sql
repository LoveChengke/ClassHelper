-- 课表下发改成「按按钮才发生」
--
-- 需求：「ClassIsland 联动改为下发或获取课表，获取课表时点击获取才会获取，而不是一直获取」。
--
-- 起因（2026-10-11 实测）：插件每 `ReportIntervalSeconds`（默认 15）秒上报一次，且
-- 本机 `UploadSchedule` 开着时**每次都带全量课表**、`MirrorSchedule` 开着时**每次上报完
-- 还顺手镜像一遍**。于是教室的课表每 15 秒被重写一次，服务端这边也每 15 秒
-- merge + 清理一次幽灵行 —— 老师看到的就是"课表被反复删改"。
--
-- 现在两个方向都只由一次性待办触发：
--   · 教室 → 服务端：`requestScheduleReport`（已有，「从教室机器获取课表」按钮）
--   · 服务端 → 教室：`requestMirrorSchedule`（本次新增，「下发课表到教室」按钮）
-- `mirrorScheduleToClassIsland` 的含义同时收窄为「这台设备接不接受下发」，不再是自动同步开关。

-- AlterTable
ALTER TABLE "IntegrationDevice" ADD COLUMN "requestMirrorSchedule" BOOLEAN NOT NULL DEFAULT false;
