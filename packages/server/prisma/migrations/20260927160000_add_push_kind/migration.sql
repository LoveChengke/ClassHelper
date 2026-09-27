-- 提醒类型：notification=通知类 / call=叫人（叫人算「主动通知」，上课时段也立即弹出）
ALTER TABLE "ClassIslandPush" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'notification';
