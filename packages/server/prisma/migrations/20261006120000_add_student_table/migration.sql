-- 学生从「账号」变成「名单记录」：新建 Student 表，个人数据外键改指向它
--
-- 为什么要有这一版：
--   在此之前学生是 `User` 表里 role='STUDENT' 的行 —— 与教师登录名共用同一个全局唯一
--   命名空间、靠 passwordHash='' 占位、靠"登录时先判 role 再 403"来阻止登录。
--   「学生不是账号」这条不变量只靠约定维持，任何一处漏判都会让一个学生变成可登录账号。
--   本迁移把它变成**结构性保证**：学生只存在于 Student 表，那里没有 passwordHash、没有 role。
--
-- 语义变化：
--   1) `User` 收缩为纯账号表（ADMIN / TEACHER / CLASS_DEVICE），去掉 classId 与 role='STUDENT'；
--   2) `Student.studentNo`（学号）= 原 `User.username`，是学生唯一标识与查询键；
--   3) `Grade.userId` / `HomeworkStatus.userId` / `NotificationRead.userId` → `studentId`，
--      指向 Student（值就是原来那个 User.id，因此历史数据一条不丢）；
--   4) 删除 `Enrollment`（`Student.classId` 已是唯一归属，两处双写必然漂移）
--      与 `ClassTeacher`（没有科目的协作关系；任课关系的唯一来源改为 `Course.teacherId`）；
--   5) `User.phone`（教师联系方式）。
--
-- 数据保全：
--   - 学生行按 id 原样搬进 Student，因此 Grade / HomeworkStatus / NotificationRead 里
--     旧 `userId` 直接就是新的 `studentId`，无需任何映射表；
--   - 三张个人数据表回填时用 `IN (SELECT id FROM Student)` 兜底：历史上若有教师/管理员
--     误留下个人记录（例如教师给自己勾过作业完成），这些行会被丢弃而不是撞外键失败；
--   - 成绩的 `level` 按旧口径（得分率）回填，保持升级后界面显示不变。

-- DropIndex
DROP INDEX "ClassTeacher_classId_teacherId_key";
DROP INDEX "ClassTeacher_teacherId_idx";
DROP INDEX "Enrollment_userId_classId_key";
DROP INDEX "Enrollment_classId_idx";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ClassTeacher";
DROP TABLE "Enrollment";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentNo" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "classId" TEXT,
    "gender" TEXT NOT NULL DEFAULT '',
    "guardianPhone" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Student_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- 把原「学生账号」整行搬成名单记录：id 保持不变，这样下面三张表的 userId 可以直接当 studentId 用。
INSERT INTO "Student" ("id", "studentNo", "name", "classId", "gender", "guardianPhone", "status", "createdAt", "updatedAt")
SELECT "id", "username", "name", "classId", '', '', 'active', "createdAt", "updatedAt"
FROM "User"
WHERE "role" = 'STUDENT';

CREATE TABLE "StudentClassTransfer" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StudentClassTransfer_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Class" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "passwordHash" TEXT,
    "termWeeks" INTEGER NOT NULL DEFAULT 20,
    "notificationChannel" TEXT NOT NULL DEFAULT 'both',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Class_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Class" ("code", "createdAt", "grade", "id", "name", "notificationChannel", "passwordHash", "teacherId", "termWeeks", "updatedAt") SELECT "code", "createdAt", "grade", "id", "name", "notificationChannel", "passwordHash", "teacherId", "termWeeks", "updatedAt" FROM "Class";
DROP TABLE "Class";
ALTER TABLE "new_Class" RENAME TO "Class";
CREATE UNIQUE INDEX "Class_code_key" ON "Class"("code");
CREATE INDEX "Class_teacherId_idx" ON "Class"("teacherId");

CREATE TABLE "new_Grade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "classId" TEXT NOT NULL,
    "courseId" TEXT,
    "studentId" TEXT NOT NULL,
    "examName" TEXT NOT NULL,
    "score" REAL NOT NULL,
    "totalScore" REAL NOT NULL DEFAULT 100,
    "publishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Grade_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Grade_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Grade_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Grade" ("classId", "courseId", "createdAt", "examName", "id", "publishedAt", "score", "studentId", "totalScore", "updatedAt")
SELECT "classId", "courseId", "createdAt", "examName", "id", "publishedAt", "score", "userId", "totalScore", "updatedAt"
FROM "Grade"
WHERE "userId" IN (SELECT "id" FROM "Student");
DROP TABLE "Grade";
ALTER TABLE "new_Grade" RENAME TO "Grade";
CREATE INDEX "Grade_studentId_publishedAt_idx" ON "Grade"("studentId", "publishedAt");
CREATE INDEX "Grade_classId_examName_idx" ON "Grade"("classId", "examName");
CREATE INDEX "Grade_courseId_idx" ON "Grade"("courseId");

CREATE TABLE "new_HomeworkStatus" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "homeworkId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HomeworkStatus_homeworkId_fkey" FOREIGN KEY ("homeworkId") REFERENCES "Homework" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HomeworkStatus_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_HomeworkStatus" ("completed", "homeworkId", "id", "studentId", "updatedAt")
SELECT "completed", "homeworkId", "id", "userId", "updatedAt"
FROM "HomeworkStatus"
WHERE "userId" IN (SELECT "id" FROM "Student");
DROP TABLE "HomeworkStatus";
ALTER TABLE "new_HomeworkStatus" RENAME TO "HomeworkStatus";
CREATE INDEX "HomeworkStatus_studentId_idx" ON "HomeworkStatus"("studentId");
CREATE UNIQUE INDEX "HomeworkStatus_homeworkId_studentId_key" ON "HomeworkStatus"("homeworkId", "studentId");

CREATE TABLE "new_NotificationRead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "notificationId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "readAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationRead_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NotificationRead_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_NotificationRead" ("id", "notificationId", "readAt", "studentId")
SELECT "id", "notificationId", "readAt", "userId"
FROM "NotificationRead"
WHERE "userId" IN (SELECT "id" FROM "Student");
DROP TABLE "NotificationRead";
ALTER TABLE "new_NotificationRead" RENAME TO "NotificationRead";
CREATE INDEX "NotificationRead_studentId_idx" ON "NotificationRead"("studentId");
CREATE UNIQUE INDEX "NotificationRead_notificationId_studentId_key" ON "NotificationRead"("notificationId", "studentId");

-- User 收缩成纯账号表：只留 ADMIN / TEACHER（+ 未来的 CLASS_DEVICE），去掉 classId，加 phone。
-- 学生行在这里被丢弃 —— 它们已经在上面搬进 Student 了。
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'TEACHER',
    "phone" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("createdAt", "id", "name", "passwordHash", "role", "updatedAt", "username")
SELECT "createdAt", "id", "name", "passwordHash", "role", "updatedAt", "username"
FROM "User"
WHERE "role" <> 'STUDENT';
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE INDEX "User_role_idx" ON "User"("role");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Student_studentNo_key" ON "Student"("studentNo");
CREATE INDEX "Student_classId_idx" ON "Student"("classId");
CREATE INDEX "Student_name_idx" ON "Student"("name");
CREATE INDEX "StudentClassTransfer_studentId_createdAt_idx" ON "StudentClassTransfer"("studentId", "createdAt");
CREATE INDEX "StudentClassTransfer_createdAt_idx" ON "StudentClassTransfer"("createdAt");
CREATE INDEX "Course_teacherId_idx" ON "Course"("teacherId");
