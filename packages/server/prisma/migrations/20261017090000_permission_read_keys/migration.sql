-- 未实现独立接口的权限不再展示；原有管理组继承对应只读能力。
DELETE FROM "PermissionGroupItem" WHERE "key" IN ('log:read', 'developer:mode');
INSERT OR IGNORE INTO "PermissionGroupItem" ("id", "groupId", "key")
SELECT "groupId" || ':roster:read', "groupId", 'roster:read' FROM "PermissionGroupItem" WHERE "key" = 'roster:manage';
INSERT OR IGNORE INTO "PermissionGroupItem" ("id", "groupId", "key")
SELECT "groupId" || ':teacher:read', "groupId", 'teacher:read' FROM "PermissionGroupItem" WHERE "key" = 'teacher:manage';
