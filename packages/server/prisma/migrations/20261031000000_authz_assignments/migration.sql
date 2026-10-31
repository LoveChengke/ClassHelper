ALTER TABLE "UserPermissionGroup" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'TEACHING';
ALTER TABLE "UserPermissionGroup" ADD COLUMN "scopeValue" TEXT NOT NULL DEFAULT '';
UPDATE "UserPermissionGroup" SET "scope" = COALESCE((SELECT CASE WHEN g."scope" = 'SELF_CLASS' THEN CASE WHEN g."scopeValue" = 'HEAD' THEN 'HEAD' ELSE 'TEACHING' END ELSE g."scope" END FROM "PermissionGroup" g WHERE g."id" = "groupId"), 'TEACHING'), "scopeValue" = COALESCE((SELECT CASE WHEN g."scope" IN ('GRADE', 'DIVISION') THEN g."scopeValue" ELSE '' END FROM "PermissionGroup" g WHERE g."id" = "groupId"), '');
UPDATE "PermissionGroup" SET "scope" = CASE WHEN "scopeValue" = 'HEAD' THEN 'HEAD' ELSE 'TEACHING' END, "scopeValue" = '' WHERE "scope" = 'SELF_CLASS';
UPDATE "PermissionGroup" SET "scope" = 'TEACHING', "scopeValue" = '' WHERE "defaultRole" = 'TEACHER';
DROP INDEX "UserPermissionGroup_userId_groupId_key";
CREATE UNIQUE INDEX "UserPermissionGroup_userId_groupId_scope_scopeValue_key" ON "UserPermissionGroup"("userId", "groupId", "scope", "scopeValue");
