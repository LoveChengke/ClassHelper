import type { ClassPeriod } from '@classhelper/shared';
import { scheduleApi } from '@/api';

/**
 * 「这几个班里有没有正在上课的」——全站共用的同一条判据。
 *
 * 为什么抽出来：上课时段发**紧急通知**要先弹全屏二次确认（`UrgentClassWarning`，3 秒倒计时），
 * 而「发通知」这件事在本项目里有**两个入口** —— 通知发布页，以及大模型助手确认后走同一批端点。
 * 判据各写一份的结果是：助手那条路少了一次检查，老师在上课时用助手发紧急通知就**没有任何警告**
 * （2026-10-11 用户实测反馈），而手动那条路有。凡是"发布前要问一句"的入口都必须用它。
 *
 * 逐班查询 `GET /api/schedules/current?classId=...`，任一班级正在上课即返回命中的那个。
 * 查询失败按"没在上课"处理（不能让一次网络抖动把发布整条路堵死），由服务端的
 * 409 `URGENT_DURING_CLASS` 兜底再问一次。
 */
export async function findClassInSession(
  classIds: string[],
): Promise<{ classId: string; period: ClassPeriod | null } | null> {
  const results = await Promise.all(
    classIds.map(async (classId) => {
      const status = await scheduleApi.classStatus(classId).catch(() => null);
      return status?.inClass ? { classId, period: status.current } : null;
    }),
  );
  return results.find((item) => item !== null) ?? null;
}
