-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Class" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "enrollmentYear" INTEGER,
    "classIndex" INTEGER,
    "teacherId" TEXT,
    "code" TEXT NOT NULL,
    "passwordHash" TEXT,
    "termWeeks" INTEGER NOT NULL DEFAULT 20,
    "termStartDate" TEXT,
    "studentGradeQueryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "archivedYearId" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Class_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Class_archivedYearId_fkey" FOREIGN KEY ("archivedYearId") REFERENCES "ArchivedYear" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Class" ("archivedAt", "archivedYearId", "classIndex", "code", "createdAt", "enrollmentYear", "grade", "id", "name", "passwordHash", "studentGradeQueryEnabled", "teacherId", "termStartDate", "termWeeks", "updatedAt") SELECT "archivedAt", "archivedYearId", "classIndex", "code", "createdAt", "enrollmentYear", "grade", "id", "name", "passwordHash", "studentGradeQueryEnabled", "teacherId", "termStartDate", "termWeeks", "updatedAt" FROM "Class";
DROP TABLE "Class";
ALTER TABLE "new_Class" RENAME TO "Class";
CREATE UNIQUE INDEX "Class_code_key" ON "Class"("code");
CREATE INDEX "Class_teacherId_idx" ON "Class"("teacherId");
CREATE INDEX "Class_enrollmentYear_idx" ON "Class"("enrollmentYear");
CREATE INDEX "Class_archivedYearId_idx" ON "Class"("archivedYearId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
