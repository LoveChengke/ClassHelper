-- 通知显示位置（由教室的班级客户端设置）：both / client / classisland
-- 旧数据默认 both：行为与之前一致（客户端照常收，同时推给 ClassIsland）
ALTER TABLE "Class" ADD COLUMN "notificationChannel" TEXT NOT NULL DEFAULT 'both';
