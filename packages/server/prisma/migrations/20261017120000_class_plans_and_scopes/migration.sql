-- CreateTable
CREATE TABLE "TimeLayoutItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timeLayoutId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "timeType" TEXT NOT NULL DEFAULT 'LESSON',
    "isHideDefault" BOOLEAN NOT NULL DEFAULT false,
    "defaultClassId" TEXT,
    "breakName" TEXT NOT NULL DEFAULT '',
    "actionSet" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "TimeLayoutItem_timeLayoutId_fkey" FOREIGN KEY ("timeLayoutId") REFERENCES "TimeLayout" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClassPlanGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "classId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isGlobal" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ClassPlanGroup_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClassPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "classId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timeLayoutId" TEXT NOT NULL,
    "associatedGroup" TEXT,
    "weekday" INTEGER NOT NULL DEFAULT 0,
    "weekCountDiv" INTEGER NOT NULL DEFAULT 0,
    "weekCountDivTotal" INTEGER NOT NULL DEFAULT 2,
    "weekStart" INTEGER NOT NULL DEFAULT 1,
    "weekEnd" INTEGER NOT NULL DEFAULT 60,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isOverlay" BOOLEAN NOT NULL DEFAULT false,
    "overlaySourceId" TEXT,
    "overlayDate" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClassPlan_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClassPlan_timeLayoutId_fkey" FOREIGN KEY ("timeLayoutId") REFERENCES "TimeLayout" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClassPlan_associatedGroup_fkey" FOREIGN KEY ("associatedGroup") REFERENCES "ClassPlanGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClassPlanEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "classPlanId" TEXT NOT NULL,
    "timeLayoutItemId" TEXT NOT NULL,
    "courseId" TEXT,
    "isChangedClass" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "location" TEXT,
    "legacyScheduleId" TEXT,
    CONSTRAINT "ClassPlanEntry_classPlanId_fkey" FOREIGN KEY ("classPlanId") REFERENCES "ClassPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClassPlanEntry_timeLayoutItemId_fkey" FOREIGN KEY ("timeLayoutItemId") REFERENCES "TimeLayoutItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClassPlanEntry_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScheduledClassPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "classId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "classPlanId" TEXT NOT NULL,
    CONSTRAINT "ScheduledClassPlan_classPlanId_fkey" FOREIGN KEY ("classPlanId") REFERENCES "ClassPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ScheduledClassPlan_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PromotionRun" (
    "year" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" TEXT NOT NULL,
    "snapshotPath" TEXT NOT NULL DEFAULT '',
    "message" TEXT NOT NULL DEFAULT '',
    "classCount" INTEGER NOT NULL DEFAULT 0,
    "studentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Course" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "initial" TEXT NOT NULL DEFAULT '',
    "isOutDoor" BOOLEAN NOT NULL DEFAULT false,
    "teacherId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Course_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Course_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Course" ("classId", "createdAt", "id", "name", "teacherId") SELECT "classId", "createdAt", "id", "name", "teacherId" FROM "Course";
DROP TABLE "Course";
ALTER TABLE "new_Course" RENAME TO "Course";
CREATE INDEX "Course_classId_idx" ON "Course"("classId");
CREATE INDEX "Course_teacherId_idx" ON "Course"("teacherId");
CREATE UNIQUE INDEX "Course_classId_name_key" ON "Course"("classId", "name");
CREATE TABLE "new_PermissionGroup" (
    "scope" TEXT NOT NULL DEFAULT 'SELF_CLASS',
    "scopeValue" TEXT NOT NULL DEFAULT '',
    "defaultRole" TEXT,
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_PermissionGroup" ("builtin", "createdAt", "defaultRole", "description", "id", "name", "updatedAt") SELECT "builtin", "createdAt", "defaultRole", "description", "id", "name", "updatedAt" FROM "PermissionGroup";
DROP TABLE "PermissionGroup";
ALTER TABLE "new_PermissionGroup" RENAME TO "PermissionGroup";
CREATE UNIQUE INDEX "PermissionGroup_defaultRole_key" ON "PermissionGroup"("defaultRole");
CREATE UNIQUE INDEX "PermissionGroup_name_key" ON "PermissionGroup"("name");
CREATE TABLE "new_TimeLayout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "classId" TEXT,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'classisland',
    "items" TEXT NOT NULL DEFAULT '[]',
    "isOverlay" BOOLEAN NOT NULL DEFAULT false,
    "overlaySourceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TimeLayout_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TimeLayout" ("classId", "createdAt", "id", "items", "name", "source", "updatedAt") SELECT "classId", "createdAt", "id", "items", "name", "source", "updatedAt" FROM "TimeLayout";
DROP TABLE "TimeLayout";
ALTER TABLE "new_TimeLayout" RENAME TO "TimeLayout";
CREATE INDEX "TimeLayout_classId_idx" ON "TimeLayout"("classId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "TimeLayoutItem_timeLayoutId_position_idx" ON "TimeLayoutItem"("timeLayoutId", "position");

-- CreateIndex
CREATE INDEX "ClassPlanGroup_classId_idx" ON "ClassPlanGroup"("classId");

-- CreateIndex
CREATE INDEX "ClassPlan_classId_weekday_idx" ON "ClassPlan"("classId", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "ClassPlanEntry_classPlanId_timeLayoutItemId_key" ON "ClassPlanEntry"("classPlanId", "timeLayoutItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledClassPlan_classId_date_key" ON "ScheduledClassPlan"("classId", "date");


-- 将旧行按实际教学周展开为完整的一天，避免不同行的周次范围互相遮挡。
INSERT INTO TimeLayout (id,classId,name,source,items,createdAt,updatedAt)
SELECT 'legacy-layout-' || classId || '-' || dayOfWeek,classId,'兼容作息 ' || dayOfWeek,'manual','[]',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM Schedule GROUP BY classId,dayOfWeek;
INSERT INTO TimeLayoutItem (id,timeLayoutId,position,name,startTime,endTime,timeType)
SELECT 'legacy-layout-' || classId || '-' || dayOfWeek || '-' || startTime || '-' || endTime,'legacy-layout-' || classId || '-' || dayOfWeek,
ROW_NUMBER() OVER (PARTITION BY classId,dayOfWeek ORDER BY startTime), '',startTime,endTime,'LESSON' FROM Schedule GROUP BY classId,dayOfWeek,startTime,endTime;
WITH RECURSIVE weeks(w) AS (SELECT 1 UNION ALL SELECT w+1 FROM weeks WHERE w<60)
INSERT INTO ClassPlan (id,classId,name,timeLayoutId,weekday,weekStart,weekEnd,createdAt,updatedAt)
SELECT 'legacy-plan-' || s.classId || '-' || s.dayOfWeek || '-' || w,s.classId,'兼容第 ' || w || ' 周星期 ' || s.dayOfWeek,'legacy-layout-' || s.classId || '-' || s.dayOfWeek,s.dayOfWeek,w,w,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM Schedule s CROSS JOIN weeks WHERE w BETWEEN s.weekStart AND s.weekEnd AND (s.weekParity='ALL' OR s.weekParity=CASE w%2 WHEN 1 THEN 'ODD' ELSE 'EVEN' END) GROUP BY s.classId,s.dayOfWeek,w;
INSERT INTO ClassPlanEntry (id,classPlanId,timeLayoutItemId,courseId,location,legacyScheduleId)
SELECT s.id || '-' || p.weekStart,p.id,t.id,s.courseId,s.location,s.id FROM ClassPlan p JOIN Schedule s ON s.classId=p.classId AND s.dayOfWeek=p.weekday
AND p.weekStart BETWEEN s.weekStart AND s.weekEnd AND (s.weekParity='ALL' OR s.weekParity=CASE p.weekStart%2 WHEN 1 THEN 'ODD' ELSE 'EVEN' END)
JOIN TimeLayoutItem t ON t.timeLayoutId=p.timeLayoutId AND t.startTime=s.startTime AND t.endTime=s.endTime
WHERE s.id=(SELECT MIN(s2.id) FROM Schedule s2 WHERE s2.classId=s.classId AND s2.dayOfWeek=s.dayOfWeek AND s2.startTime=s.startTime AND s2.endTime=s.endTime AND p.weekStart BETWEEN s2.weekStart AND s2.weekEnd AND (s2.weekParity='ALL' OR s2.weekParity=CASE p.weekStart%2 WHEN 1 THEN 'ODD' ELSE 'EVEN' END));

-- 升级现有角色默认组，新增的两个管理能力初始只给管理员。
INSERT INTO PermissionGroupItem (id,groupId,key,createdAt) SELECT 'v14-timetable-' || id,id,'timetable:manage',CURRENT_TIMESTAMP FROM PermissionGroup WHERE defaultRole='ADMIN';
INSERT INTO PermissionGroupItem (id,groupId,key,createdAt) SELECT 'v14-update-' || id,id,'client:update',CURRENT_TIMESTAMP FROM PermissionGroup WHERE defaultRole='ADMIN';

UPDATE Course SET initial=substr(name,1,1) WHERE initial='';

-- 仅保留旧接口返回字段；课表解析不读取它，业务启用规则仍以日课表为唯一真值。
INSERT INTO AppSetting (key,value,createdAt,updatedAt) SELECT 'schedule.compat.' || id,json_object('weekStart',weekStart,'weekEnd',weekEnd,'weekParity',weekParity),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM Schedule;
