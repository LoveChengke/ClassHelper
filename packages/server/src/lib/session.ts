import { classDeviceClassId, isClassDevice } from './access.js';
import { prisma } from './db.js';
import type { TokenPayload } from './jwt.js';

/**
 * 会话主体解析：staff 账号（管理员 / 教师）vs ClassHelper 班级端。
 *
 * 背景：**学生不是账号**（`Student` 只是班级名单记录），因此班级端成为个人数据的唯一读写主体。
 * 班级端的 JWT 形如：
 *   { sub: <classId>, username: <班级码>, name: <班级名>, role: 'CLASS_DEVICE',
 *     classId: <classId>, classSession: true }
 *
 * 语义：
 * - **班级端代全班操作**：勾选作业完成、标记通知已读，都会写到该班全体学生的记录上，
 *   因此教师端的"完成人数/已读人数"统计依然准确；
 * - 读状态判定使用 `studentId in 全班学生`：任一条记录存在即视为该班设备读过/完成过；
 * - 所有个人数据的读写都收敛到 `resolvePersonalIds()` 一个入口。
 */
export { isClassDevice };

/** 班级端对应的班级 id；不是班级端会话时为 null */
export function classSessionClassId(user: TokenPayload): string | null {
  return classDeviceClassId(user);
}

/** 该班级的全部学生 id（班级端的"全班"范围） */
export async function listClassStudentIds(classId: string): Promise<string[]> {
  const students = await prisma.student.findMany({
    where: { classId, status: { not: 'inactive' } },
    select: { id: true },
  });
  return students.map((item) => item.id);
}

/**
 * 当前会话的"个人记录主体"列表：
 * - ClassHelper 班级端：全班学生的 id；
 * - 教师 / 管理员：空数组 —— 他们没有"个人作业完成/成绩"这类记录。
 */
export async function resolvePersonalIds(user: TokenPayload): Promise<string[]> {
  const classId = classDeviceClassId(user);
  if (classId) return listClassStudentIds(classId);
  return [];
}

/** Prisma 过滤片段：`{ studentId: { in: ids } }` */
export function personalIdWhere(ids: string[]): { studentId: { in: string[] } } {
  return { studentId: { in: ids } };
}
