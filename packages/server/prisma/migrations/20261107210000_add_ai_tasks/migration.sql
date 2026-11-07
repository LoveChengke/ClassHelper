CREATE TABLE "AiTask" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'preparing',
  "input" TEXT NOT NULL,
  "result" TEXT NOT NULL DEFAULT '',
  "events" TEXT NOT NULL DEFAULT '',
  "error" TEXT NOT NULL DEFAULT '',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "AiTask_userId_createdAt_idx" ON "AiTask"("userId", "createdAt");
