ALTER TABLE "Courseware" ADD COLUMN "archivePath" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Courseware" ADD COLUMN "folderPath" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ClientDevice" ADD COLUMN "updateProgress" TEXT NOT NULL DEFAULT '';
CREATE TABLE "CoursewareFolder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CoursewareFolder_ownerId_path_key" ON "CoursewareFolder"("ownerId", "path");
