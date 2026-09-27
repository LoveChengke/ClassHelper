-- ClassIsland 联动：设备接入 + 提醒下发
--
-- 说明：
-- 1) IntegrationDevice 保存「班级 ↔ 一台装有联动插件的机器」的绑定关系，
--    令牌只存 sha256 哈希，明文仅在创建/重置接口返回一次。
-- 2) 同一班级内 deviceKey 唯一：插件重装后带同一机器码会重绑原记录，避免设备列表堆重复项。
-- 3) ClassIslandPush 落库是为了「设备离线时通知不丢」：插件重连后拉取未确认的一条立即弹出。
-- 4) 本文件重复执行是安全的（逐条执行、忽略"已存在"错误）。

CREATE TABLE "IntegrationDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "classId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'plugin',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "tokenHash" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL,
    "syncScheduleToServer" BOOLEAN NOT NULL DEFAULT true,
    "mirrorScheduleToClassIsland" BOOLEAN NOT NULL DEFAULT false,
    "classIslandVersion" TEXT,
    "pluginVersion" TEXT,
    "lastSeenAt" DATETIME,
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

CREATE UNIQUE INDEX "IntegrationDevice_classId_deviceKey_key" ON "IntegrationDevice"("classId", "deviceKey");
CREATE INDEX "IntegrationDevice_classId_idx" ON "IntegrationDevice"("classId");
CREATE INDEX "IntegrationDevice_tokenHash_idx" ON "IntegrationDevice"("tokenHash");

CREATE TABLE "ClassIslandPush" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "classId" TEXT NOT NULL,
    "deviceId" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "durationSeconds" INTEGER NOT NULL DEFAULT 8,
    "speechContent" TEXT,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "notificationId" TEXT,
    "ackedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "ClassIslandPush_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClassIslandPush_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "IntegrationDevice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ClassIslandPush_classId_createdAt_idx" ON "ClassIslandPush"("classId", "createdAt");
CREATE INDEX "ClassIslandPush_deviceId_ackedAt_idx" ON "ClassIslandPush"("deviceId", "ackedAt");