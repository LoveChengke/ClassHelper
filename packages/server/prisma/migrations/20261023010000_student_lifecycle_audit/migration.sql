ALTER TABLE "StudentClassTransfer" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'class-change';
ALTER TABLE "StudentClassTransfer" ADD COLUMN "batchId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "StudentClassTransfer" ADD COLUMN "academicYear" INTEGER;
ALTER TABLE "StudentClassTransfer" ADD COLUMN "fromGrade" TEXT NOT NULL DEFAULT '';
ALTER TABLE "StudentClassTransfer" ADD COLUMN "toGrade" TEXT NOT NULL DEFAULT '';
ALTER TABLE "StudentClassTransfer" ADD COLUMN "fromSchool" TEXT NOT NULL DEFAULT '';
ALTER TABLE "StudentClassTransfer" ADD COLUMN "toSchool" TEXT NOT NULL DEFAULT '';
UPDATE "StudentClassTransfer" SET "kind" = CASE "mode" WHEN 'transfer-out' THEN 'transfer-out' WHEN 'restore-transfer' THEN 'restore' ELSE 'class-change' END;
ALTER TABLE "StudentClassTransfer" DROP COLUMN "mode";
CREATE INDEX "StudentClassTransfer_batchId_idx" ON "StudentClassTransfer"("batchId");
ALTER TABLE "ArchivedYear" ADD COLUMN "inactiveCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PromotionRun" ADD COLUMN "operatorId" TEXT;
ALTER TABLE "PromotionRun" ADD COLUMN "operatorName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PromotionRun" ADD COLUMN "detailsJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "PromotionRun" ADD COLUMN "snapshotSha256" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PromotionRun" ADD COLUMN "error" TEXT NOT NULL DEFAULT '';
CREATE TABLE "PermissionAudit" (
 "id" TEXT NOT NULL PRIMARY KEY, "actorId" TEXT NOT NULL, "actorName" TEXT NOT NULL,
 "action" TEXT NOT NULL, "targetType" TEXT NOT NULL, "targetId" TEXT NOT NULL,
 "beforeJson" TEXT NOT NULL DEFAULT '{}', "afterJson" TEXT NOT NULL DEFAULT '{}',
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PermissionAudit_createdAt_idx" ON "PermissionAudit"("createdAt");
