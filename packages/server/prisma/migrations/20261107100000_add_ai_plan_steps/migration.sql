CREATE TABLE "AiPlanStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "result" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "AiPlanStep_auditId_ordinal_key" ON "AiPlanStep"("auditId", "ordinal");
CREATE INDEX "AiPlanStep_userId_createdAt_idx" ON "AiPlanStep"("userId", "createdAt");
