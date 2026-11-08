ALTER TABLE "TimeLayout" ADD COLUMN "parentId" TEXT;
ALTER TABLE "TimeLayoutItem" ADD COLUMN "slotKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "TimeLayoutItem" ADD COLUMN "isAutoBreak" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiTask" ADD COLUMN "conversationId" TEXT;
ALTER TABLE "AiTask" ADD COLUMN "turnNumber" INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX "AiTask_conversationId_turnNumber_key" ON "AiTask"("conversationId", "turnNumber");
CREATE TABLE "AiConversation" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "title" TEXT NOT NULL DEFAULT '', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL);
CREATE INDEX "AiConversation_userId_updatedAt_idx" ON "AiConversation"("userId", "updatedAt");
