-- 移除退役联动数据；业务课表保留并归为手工管理。
DROP TABLE IF EXISTS "ClassIslandPush";
DROP TABLE IF EXISTS "IntegrationDevice";
ALTER TABLE "Class" DROP COLUMN "notificationChannel";
UPDATE "Schedule" SET "source" = 'manual' WHERE "source" = 'classisland';

-- 默认组按角色绑定，改名也不会失去对应关系。
ALTER TABLE "PermissionGroup" ADD COLUMN "defaultRole" TEXT;
CREATE UNIQUE INDEX "PermissionGroup_defaultRole_key" ON "PermissionGroup"("defaultRole");
DELETE FROM "PermissionGroupItem" WHERE "key" IN ('device:manage', 'classisland:notify');

ALTER TABLE "ClientDevice" ADD COLUMN "updateMode" TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE "ClientDevice" ADD COLUMN "updateNotBefore" DATETIME;
