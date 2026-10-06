-- 毕业归档：届别档案 + 班级/学生的归档标记
--
-- 背景（需求）：管理员要有一个「归档」页，按**年度**记录毕业的班级与学生、当年转出的学生，
-- 以及毕业班级发过的作业与通知；**未毕业而升级的班级不归档、数据沿用**。
--
-- 关键设计：**归档是打标记 + 只读，不删任何数据**。
--   `ArchivedYear` 是届别档案（入学年份 + 毕业年份 + 归档时的统计快照）；
--   `Class.archivedYearId` / `Student.archivedYearId` 指向它，常规列表据此过滤掉归档项；
--   毕业班级的作业与通知原样留在库里（`Homework.classId` / `Notification.classId` 不变），
--   归档详情页只读地查它们 —— 「记录每个年度毕业班级的消息和作业」就是这么满足的。
--
-- 升级 ≠ 归档：高一 → 高二 只改 `Class.grade`，班级记录、学生名单、作业成绩全部沿用，
-- 不碰 archivedYearId。因此归档只能由管理员在归档页显式执行。
--
-- 班级称呼改成「XXXX级X班」：新列 `enrollmentYear`（入学年份）+ `classIndex`（班号），
-- `Class.name` 由服务端按二者生成。下面会对**已有班级**做一次尽力而为的推断回填。

-- CreateTable
CREATE TABLE "ArchivedYear" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "enrollmentYear" INTEGER NOT NULL,
    "graduationYear" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "operatorId" TEXT,
    "operatorName" TEXT NOT NULL DEFAULT '',
    "classCount" INTEGER NOT NULL DEFAULT 0,
    "studentCount" INTEGER NOT NULL DEFAULT 0,
    "transferredCount" INTEGER NOT NULL DEFAULT 0,
    "homeworkCount" INTEGER NOT NULL DEFAULT 0,
    "notificationCount" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Class" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "enrollmentYear" INTEGER,
    "classIndex" INTEGER,
    "teacherId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "passwordHash" TEXT,
    "termWeeks" INTEGER NOT NULL DEFAULT 20,
    "notificationChannel" TEXT NOT NULL DEFAULT 'both',
    "studentGradeQueryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "archivedYearId" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Class_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Class_archivedYearId_fkey" FOREIGN KEY ("archivedYearId") REFERENCES "ArchivedYear" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Class" ("code", "createdAt", "grade", "id", "name", "notificationChannel", "passwordHash", "studentGradeQueryEnabled", "teacherId", "termWeeks", "updatedAt") SELECT "code", "createdAt", "grade", "id", "name", "notificationChannel", "passwordHash", "studentGradeQueryEnabled", "teacherId", "termWeeks", "updatedAt" FROM "Class";
DROP TABLE "Class";
ALTER TABLE "new_Class" RENAME TO "Class";
CREATE UNIQUE INDEX "Class_code_key" ON "Class"("code");
CREATE INDEX "Class_teacherId_idx" ON "Class"("teacherId");
CREATE INDEX "Class_enrollmentYear_idx" ON "Class"("enrollmentYear");
CREATE INDEX "Class_archivedYearId_idx" ON "Class"("archivedYearId");

-- 已有班级的届别推断（尽力而为）：
--   入学年份 = 当前学年起始年 − 该班现在的年级偏移。学年在 9 月切换，
--   所以 9 月及以后算今年起始、之前算去年起始；高一偏移 0、高二 1、高三 2，
--   认不出的年级（初中 / 四年制等）按高三处理（宁可偏早，管理员可在班级管理页改正）。
UPDATE "Class"
SET "enrollmentYear" = (
      CASE WHEN CAST(strftime('%m', 'now') AS INTEGER) >= 9
           THEN CAST(strftime('%Y', 'now') AS INTEGER)
           ELSE CAST(strftime('%Y', 'now') AS INTEGER) - 1 END
    ) - CASE "grade" WHEN '高二' THEN 1 WHEN '高三' THEN 2 ELSE 0 END
WHERE "enrollmentYear" IS NULL;

-- 班号按「同一届内按创建先后」编号（老名字里的括号数字没法跨库 reliably 解析，这是等价的近似）。
UPDATE "Class"
SET "classIndex" = (
  SELECT COUNT(*) FROM "Class" c2
  WHERE c2."enrollmentYear" = "Class"."enrollmentYear"
    AND (c2."createdAt" < "Class"."createdAt"
         OR (c2."createdAt" = "Class"."createdAt" AND c2."id" <= "Class"."id"))
)
WHERE "classIndex" IS NULL;

-- 按新口径重写称呼：「2026级1班」。管理员若觉得推断不对，可在班级管理页改入学年份/班号。
UPDATE "Class"
SET "name" = CAST("enrollmentYear" AS TEXT) || '级' || CAST("classIndex" AS TEXT) || '班'
WHERE "enrollmentYear" IS NOT NULL AND "classIndex" IS NOT NULL;

CREATE TABLE "new_Student" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentNo" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "classId" TEXT,
    "gender" TEXT NOT NULL DEFAULT '',
    "guardianPhone" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "archivedYearId" TEXT,
    "archivedAt" DATETIME,
    "transferredAt" DATETIME,
    "transferNote" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Student_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Student_archivedYearId_fkey" FOREIGN KEY ("archivedYearId") REFERENCES "ArchivedYear" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Student" ("classId", "createdAt", "gender", "guardianPhone", "id", "name", "status", "studentNo", "updatedAt") SELECT "classId", "createdAt", "gender", "guardianPhone", "id", "name", "status", "studentNo", "updatedAt" FROM "Student";
DROP TABLE "Student";
ALTER TABLE "new_Student" RENAME TO "Student";
CREATE UNIQUE INDEX "Student_studentNo_key" ON "Student"("studentNo");
CREATE INDEX "Student_classId_idx" ON "Student"("classId");
CREATE INDEX "Student_name_idx" ON "Student"("name");
CREATE INDEX "Student_status_idx" ON "Student"("status");
CREATE INDEX "Student_archivedYearId_idx" ON "Student"("archivedYearId");

CREATE TABLE "new_StudentClassTransfer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentId" TEXT NOT NULL,
    "studentNo" TEXT NOT NULL,
    "studentName" TEXT NOT NULL,
    "fromClassId" TEXT,
    "fromClassName" TEXT NOT NULL DEFAULT '',
    "toClassId" TEXT,
    "toClassName" TEXT NOT NULL DEFAULT '',
    "operatorId" TEXT,
    "operatorName" TEXT NOT NULL DEFAULT '',
    "mode" TEXT NOT NULL DEFAULT 'single',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StudentClassTransfer_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_StudentClassTransfer" ("createdAt", "fromClassId", "fromClassName", "id", "mode", "operatorId", "operatorName", "studentId", "studentName", "studentNo", "toClassId", "toClassName") SELECT "createdAt", "fromClassId", "fromClassName", "id", "mode", "operatorId", "operatorName", "studentId", "studentName", "studentNo", "toClassId", "toClassName" FROM "StudentClassTransfer";
DROP TABLE "StudentClassTransfer";
ALTER TABLE "new_StudentClassTransfer" RENAME TO "StudentClassTransfer";
CREATE INDEX "StudentClassTransfer_studentId_createdAt_idx" ON "StudentClassTransfer"("studentId", "createdAt");
CREATE INDEX "StudentClassTransfer_createdAt_idx" ON "StudentClassTransfer"("createdAt");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ArchivedYear_enrollmentYear_key" ON "ArchivedYear"("enrollmentYear");
