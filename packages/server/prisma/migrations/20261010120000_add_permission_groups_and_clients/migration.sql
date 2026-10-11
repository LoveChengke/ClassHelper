-- 权限组 / 全局设置 / 客户端设备与远控 / 客户端安装包缓存 / 大模型审计
--
-- 一、权限组（需求：「允许 admin 设置各用户权限，或创建权限组」）
--   `PermissionGroup`     权限组本体（名字 + 说明 + 是否内置）
--   `PermissionGroupItem` 组里的一条权限键（键目录在 shared 的 PERMISSION_KEYS）
--   `UserPermissionGroup` 账号与组的分配关系（一个账号可属多个组）
--   语义：账号没有任何分组时回落角色默认模板（ROLE_DEFAULT_PERMISSIONS，逐条镜像改造前的
--   路由 requireRole）；一旦分组，生效集合只由组的并集决定（因此也能用来收回权限）。
--
-- 二、全局设置 `AppSetting`（大模型开关与配置、开发者模式等）——值一律字符串，密钥加密后存。
--
-- 三、客户端设备与统一更新（需求：「服务端显示各班 ClassHelper 版本，可一键推送更新」）
--   `ClientDevice`   每台客户端一条：班级 / 版本 / 平台 / 是否自动更新 / 目标版本 / 心跳时间
--   `ClientCommand`  远控指令（关机 / 重启 / 注销 / 锁屏）：心跳拉取 + 回执，不新增握手通道
--   `ClientRelease`  服务端缓存的安装包：教室机器没有外网也能更新
--   在线判定看 `lastHeartbeatAt`（心跳 60 秒一次，窗口见 shared 的 CLASS_HELPER_ONLINE_WINDOW_MS）。
--
-- 四、通知按天归档（需求：「通知发布按天归档」）
--   `Notification.assignDate` 与 `Homework.assignDate` 同口径（本地日期 YYYY-MM-DD，不带时区）。
--   回填：历史数据按 createdAt 的**本地日期**补写，避免归档页出现一堆"无日期"的旧通知。
--
-- 五、关怀模式 `User.careMode`（需求：「关怀模式（部分老师年纪大使用不习惯）」）。
--
-- 注意：本仓库的 SQLite / MySQL 双库约束是「只用 String / Int / Float / Boolean / DateTime」，
-- 因此上面这些"枚举"（指令类型、审计状态）都是 String + 服务端 zod 校验。

-- AlterTable
ALTER TABLE "User" ADD COLUMN "careMode" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "assignDate" TEXT NOT NULL DEFAULT '';

-- 历史通知按本地日期回填（date() 解不了的值兜底成"今天"，避免留空）
UPDATE "Notification" SET "assignDate" = date("createdAt", 'localtime') WHERE "assignDate" = '';
UPDATE "Notification" SET "assignDate" = date('now', 'localtime') WHERE "assignDate" = '';

-- CreateTable
CREATE TABLE "PermissionGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PermissionGroupItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PermissionGroupItem_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PermissionGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserPermissionGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserPermissionGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserPermissionGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PermissionGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ClientDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "classId" TEXT,
    "deviceKey" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "clientVersion" TEXT NOT NULL DEFAULT '',
    "platform" TEXT NOT NULL DEFAULT '',
    "autoUpdate" BOOLEAN NOT NULL DEFAULT true,
    "updateTargetVersion" TEXT NOT NULL DEFAULT '',
    "pendingVersion" TEXT NOT NULL DEFAULT '',
    "lastHeartbeatAt" DATETIME,
    "lastIp" TEXT NOT NULL DEFAULT '',
    "stateNote" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClientDevice_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClientCommand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "ackedAt" DATETIME,
    "result" TEXT NOT NULL DEFAULT '',
    "cancelledAt" DATETIME,
    CONSTRAINT "ClientCommand_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ClientDevice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClientRelease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL DEFAULT '',
    "size" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AiAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "intent" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "message" TEXT NOT NULL DEFAULT '',
    "rawReply" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "PermissionGroup_name_key" ON "PermissionGroup"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PermissionGroupItem_groupId_key_key" ON "PermissionGroupItem"("groupId", "key");

-- CreateIndex
CREATE INDEX "PermissionGroupItem_groupId_idx" ON "PermissionGroupItem"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPermissionGroup_userId_groupId_key" ON "UserPermissionGroup"("userId", "groupId");

-- CreateIndex
CREATE INDEX "UserPermissionGroup_userId_idx" ON "UserPermissionGroup"("userId");

-- CreateIndex
CREATE INDEX "UserPermissionGroup_groupId_idx" ON "UserPermissionGroup"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientDevice_deviceKey_key" ON "ClientDevice"("deviceKey");

-- CreateIndex
CREATE INDEX "ClientDevice_classId_idx" ON "ClientDevice"("classId");

-- CreateIndex
CREATE INDEX "ClientDevice_lastHeartbeatAt_idx" ON "ClientDevice"("lastHeartbeatAt");

-- CreateIndex
CREATE INDEX "ClientCommand_deviceId_ackedAt_idx" ON "ClientCommand"("deviceId", "ackedAt");

-- CreateIndex
CREATE INDEX "ClientCommand_createdAt_idx" ON "ClientCommand"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClientRelease_version_key" ON "ClientRelease"("version");

-- CreateIndex
CREATE INDEX "AiAudit_userId_createdAt_idx" ON "AiAudit"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_classId_assignDate_idx" ON "Notification"("classId", "assignDate");
