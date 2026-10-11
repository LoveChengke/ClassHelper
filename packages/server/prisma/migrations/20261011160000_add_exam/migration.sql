-- 成绩：按考试记住「是否把所有科目相加以总分排名」
--
-- 需求：「单次考试（如月考，期中考），在导入成绩时可选是否将所有科目相加以总分排名，
-- 客户端也可查看到总分排名和个别单科的排名」。
--
-- `Grade.examName` 一直是自由文本，服务端光看它不知道这次考试算不算总分；而客户端要显示
-- 总分榜就必须知道，所以按「班级 + 考试名」单独记一条 `Exam`。
--
-- 与 `Grade` 是**弱关联**：两边只按名字匹配，不建外键。成绩删光不会连带删掉设置，
-- 补录同一场考试时设置还在。
--
-- 注意：本仓库的 SQLite / MySQL 双库约束是「只用 String / Int / Float / Boolean / DateTime」，
-- 因此这里没有 enum、没有 @db.*。

-- CreateTable
CREATE TABLE "Exam" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "classId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countInTotal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Exam_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Exam_classId_name_key" ON "Exam"("classId", "name");

-- CreateIndex
CREATE INDEX "Exam_classId_idx" ON "Exam"("classId");
