import { prisma } from './db.js';
import type { TokenPayload } from './jwt.js';

/**
 * 会话主体解析：普通账号 vs 班级账号（班级设备）。
 *
 * 背景（需求 1）：学生端以「班级」为主体登录，个人学生不再作为登录入口。
 * 班级账号的 JWT 形如：
 *   { sub: <classId>, username: <班级码>, name: <班级名>, role: 'STUDENT',
 *     classId: <classId>, classSession: true }
 *
 * 语义（由用户确认）：
 * - **班级设备代全班操作**：勾选作业完成、标记通知已读，都会写到该班全体学生的记录上，
 *   因此教师端的"完成人数/已读人数"统计依然准确；
 * - 读状态判定使用 `userId in 全班学生`：任一条记录存在即视为该班设备读过/完成过；
 * - 个人学生账号（student01…）保持完全兼容，此时"全班"范围退化为"只有自己"。
 *
 * 这样所有个人数据的读写都收敛到 `resolvePersonalIds()` 一个入口，
 * 既不需要改数据库结构，也不会让旧的个人账号行为发生变化。
 */
export function isClassSession(user: TokenPayload): boolean {
  return user.role === 'STUDENT' && user.classSession === true;
}

/** 班级账号对应的班级 id */
export function classSessionClassId(user: TokenPayload): string {
  return user.classId ?? user.sub;
}

/** 该班级的全部学生 id（班级账号的"全班"范围） */
export async function listClassStudentIds(classId: string): Promise<string[]> {
  const students = await prisma.user.findMany({
    where: { classId, role: 'STUDENT' },
    select: { id: true },
  });
  return students.map((item) => item.id);
}

/**
 * 当前会话的"个人记录主体"列表：
 * - 普通学生：自己
 * - 班级账号：全班学生
 * - 教师/管理员：自己（教师侧的完成情况统计走 withStatus，不依赖这个列表）
 */
export async function resolvePersonalIds(user: TokenPayload): Promise<string[]> {
  if (isClassSession(user)) return listClassStudentIds(classSessionClassId(user));
  return [user.sub];
}

/** Prisma 过滤片段：`{ userId: { in: ids } }` */
export function personalIdWhere(ids: string[]): { userId: { in: string[] } } {
  return { userId: { in: ids } };
}
