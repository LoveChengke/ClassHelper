-- ClassHelper 班级端心跳时间：把「在线判定」和「最后带状态的上报」拆成两个字段
--
-- 原先只有一个 `lastSeenAt`（每次上报都刷）。但同一台设备的上报其实有两种：
--   - **心跳**：插件每隔 60 秒打一次，只表明"我还在线"；
--   - **状态上报**：带运行状态 / 课表，表明"我拿到了新东西"。
-- 合成一个字段后，教师网页无法区分「设备在线但一直没有新状态」和「设备整个失联」。
--
-- 于是：
--   `lastHeartbeatAt` 每次上报都刷新 —— **在线判定看它**（60 秒窗口，见 shared 的
--                     `CLASS_HELPER_ONLINE_WINDOW_MS`）；
--   `lastSeenAt`      只在带运行状态的上报时刷新 —— 展示为「最后在线时间」。
--
-- 回填：老库只有 lastSeenAt，就把它当作心跳时间的初值（否则所有设备升级后都会显示"从未心跳"）。
ALTER TABLE "IntegrationDevice" ADD COLUMN "lastHeartbeatAt" DATETIME;
UPDATE "IntegrationDevice" SET "lastHeartbeatAt" = "lastSeenAt" WHERE "lastHeartbeatAt" IS NULL;
