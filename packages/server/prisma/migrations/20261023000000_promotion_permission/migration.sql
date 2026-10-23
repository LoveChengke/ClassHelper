-- 已存在的管理员默认组补升级键；默认组尚未初始化时由运行时模板创建。
INSERT INTO "PermissionGroupItem" ("id", "groupId", "key")
SELECT 'promotion-key-' || "id", "id", 'promotion:manage'
FROM "PermissionGroup"
WHERE "defaultRole" = 'ADMIN'
AND NOT EXISTS (SELECT 1 FROM "PermissionGroupItem" i WHERE i."groupId" = "PermissionGroup"."id" AND i."key" = 'promotion:manage');
