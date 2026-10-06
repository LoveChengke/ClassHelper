-- 学期周次配置 + 课表同步方向反转
--
-- 一、学期周次（需求：「第几周的周次数据可以由 admin 修改」）
--   `TermWeek` 让管理员为**每一个教学周**指定实际的起止日期（调休、周末补课、错峰开学），
--   `classId = ''` 表示全校默认；没配到的周次仍按学期开始日期线性兜底。
--   `Class.termStartDate` 允许某个班单独覆盖全局的开学日期（它随镜像课表下发给教室的 ClassIsland）。
--
-- 二、课表同步方向反转（需求：「课表不再自动从教室的 ClassIsland 获取，改为手动获取；
--    ClassHelper 班级端的课表由服务端自动下发」）
--   `syncScheduleToServer`        默认 true → **false**：插件不再自动把教室的课表推上来
--   `mirrorScheduleToClassIsland` 默认 false → **true**：服务端的课表自动下发给教室
--   `requestScheduleReport`       新增：Web 端点「从教室机器获取课表」时置位，
--                                 插件下次心跳看到就把当前课表推上来并清除标记
--
--   下面会把**已有设备**也改成新方向：这正是需求要的行为变化（否则升级后教室里
--   仍然在自动回传，老师手排的课会被教室的旧课表悄悄覆盖）。设备管理员可以逐台改回去。

-- AlterTable
ALTER TABLE "Class" ADD COLUMN "termStartDate" TEXT;

-- CreateTable
CREATE TABLE "TermWeek" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "classId" TEXT NOT NULL DEFAULT '',
    "weekNumber" INTEGER NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_IntegrationDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "classId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'plugin',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "tokenHash" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL,
    "syncScheduleToServer" BOOLEAN NOT NULL DEFAULT false,
    "mirrorScheduleToClassIsland" BOOLEAN NOT NULL DEFAULT true,
    "requestScheduleReport" BOOLEAN NOT NULL DEFAULT false,
    "classIslandVersion" TEXT,
    "pluginVersion" TEXT,
    "lastSeenAt" DATETIME,
    "lastHeartbeatAt" DATETIME,
    "classPlanLoaded" BOOLEAN NOT NULL DEFAULT false,
    "currentSubject" TEXT,
    "currentTimeState" TEXT,
    "currentPeriodStart" TEXT,
    "currentPeriodEnd" TEXT,
    "nextSubject" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IntegrationDevice_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_IntegrationDevice" ("classId", "classIslandVersion", "classPlanLoaded", "createdAt", "currentPeriodEnd", "currentPeriodStart", "currentSubject", "currentTimeState", "deviceKey", "enabled", "id", "lastHeartbeatAt", "lastSeenAt", "mirrorScheduleToClassIsland", "mode", "name", "nextSubject", "pluginVersion", "syncScheduleToServer", "tokenHash", "tokenHint", "updatedAt") SELECT "classId", "classIslandVersion", "classPlanLoaded", "createdAt", "currentPeriodEnd", "currentPeriodStart", "currentSubject", "currentTimeState", "deviceKey", "enabled", "id", "lastHeartbeatAt", "lastSeenAt", "mirrorScheduleToClassIsland", "mode", "name", "nextSubject", "pluginVersion", "syncScheduleToServer", "tokenHash", "tokenHint", "updatedAt" FROM "IntegrationDevice";

-- 已有设备切到新方向：不再自动回传课表，改为由服务端自动下发。
UPDATE "new_IntegrationDevice" SET "syncScheduleToServer" = false, "mirrorScheduleToClassIsland" = true;

DROP TABLE "IntegrationDevice";
ALTER TABLE "new_IntegrationDevice" RENAME TO "IntegrationDevice";
CREATE INDEX "IntegrationDevice_classId_idx" ON "IntegrationDevice"("classId");
CREATE INDEX "IntegrationDevice_tokenHash_idx" ON "IntegrationDevice"("tokenHash");
CREATE UNIQUE INDEX "IntegrationDevice_classId_deviceKey_key" ON "IntegrationDevice"("classId", "deviceKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "TermWeek_classId_idx" ON "TermWeek"("classId");

-- CreateIndex
CREATE UNIQUE INDEX "TermWeek_classId_weekNumber_key" ON "TermWeek"("classId", "weekNumber");
