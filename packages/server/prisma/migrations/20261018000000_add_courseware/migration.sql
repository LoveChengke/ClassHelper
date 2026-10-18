CREATE TABLE "Courseware" (
  "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "name" TEXT NOT NULL,
  "size" INTEGER NOT NULL, "category" TEXT NOT NULL, "extension" TEXT NOT NULL,
  "archiveDate" TEXT NOT NULL, "storagePath" TEXT NOT NULL, "sha256" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Courseware_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Courseware_storagePath_key" ON "Courseware"("storagePath");
CREATE INDEX "Courseware_ownerId_createdAt_idx" ON "Courseware"("ownerId", "createdAt");
CREATE TABLE "CoursewareVisibility" (
  "coursewareId" TEXT NOT NULL, "classId" TEXT NOT NULL, PRIMARY KEY ("coursewareId", "classId"),
  FOREIGN KEY ("coursewareId") REFERENCES "Courseware"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CoursewareVisibility_classId_idx" ON "CoursewareVisibility"("classId");
CREATE TABLE "CoursewarePush" (
  "id" TEXT NOT NULL PRIMARY KEY, "coursewareId" TEXT NOT NULL, "classId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("coursewareId") REFERENCES "Courseware"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CoursewarePush_classId_createdAt_idx" ON "CoursewarePush"("classId", "createdAt");
CREATE TABLE "CoursewareReceipt" (
  "pushId" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "completedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("pushId", "deviceId"),
  FOREIGN KEY ("pushId") REFERENCES "CoursewarePush"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("deviceId") REFERENCES "ClientDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- 仅为旧默认组和内置教学岗位补充新能力；自定义组仍需管理员按需授权。
INSERT INTO "PermissionGroupItem" ("id", "groupId", "key")
SELECT 'cw-read-' || "id", "id", 'courseware:read' FROM "PermissionGroup"
WHERE "defaultRole" IN ('ADMIN', 'TEACHER') OR "id" IN ('builtin-head', 'builtin-teacher');
INSERT INTO "PermissionGroupItem" ("id", "groupId", "key")
SELECT 'cw-write-' || "id", "id", 'courseware:write' FROM "PermissionGroup"
WHERE "defaultRole" IN ('ADMIN', 'TEACHER') OR "id" IN ('builtin-head', 'builtin-teacher');
