import type { UserDto } from '@classhelper/shared';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import { toUserDto } from '../../lib/mappers.js';
import { hashPassword } from '../../lib/password.js';
import type {
  CreateTeacherInput,
  ResetTeacherPasswordInput,
  UpdateTeacherInput,
} from './teachers.schemas.js';

/**
 * 教师管理（**仅管理员**，路由层已用 requireRole('ADMIN') 兜住）：
 * 录入教师是管理员专属操作，班主任与科任老师都没有该权限。
 * 学生名单在 students 模块，两个模块结构保持一致（列表 / 新建 / 编辑 / 重置密码 / 删除）。
 */

/** 教师列表（教师 + 管理员账号） */
export async function listTeachers(keyword?: string): Promise<UserDto[]> {
  const teachers = await prisma.user.findMany({
    where: {
      role: { in: ['TEACHER', 'ADMIN'] },
      ...(keyword ? { OR: [{ name: { contains: keyword } }, { username: { contains: keyword } }] } : {}),
    },
    orderBy: [{ role: 'asc' }, { username: 'asc' }],
    take: 500,
  });
  return teachers.map(toUserDto);
}

export async function createTeacher(input: CreateTeacherInput): Promise<UserDto> {
  const created = await prisma.user.create({
    data: {
      username: input.username,
      name: input.name,
      role: input.role ?? 'TEACHER',
      passwordHash: await hashPassword(input.password ?? env.defaultTeacherPassword),
    },
  });
  return toUserDto(created);
}

/** 取教师账号（不存在或不是教师/管理员一律 404，避免越权探测） */
async function findTeacherOrThrow(teacherId: string): Promise<{ id: string; role: string; name: string }> {
  const teacher = await prisma.user.findUnique({
    where: { id: teacherId },
    select: { id: true, role: true, name: true },
  });
  if (!teacher || (teacher.role !== 'TEACHER' && teacher.role !== 'ADMIN')) {
    throw ApiError.notFound('教师账号不存在');
  }
  return teacher;
}

export async function updateTeacher(teacherId: string, input: UpdateTeacherInput): Promise<UserDto> {
  const teacher = await findTeacherOrThrow(teacherId);
  const updated = await prisma.user.update({
    where: { id: teacher.id },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.username ? { username: input.username } : {}),
      ...(input.role ? { role: input.role } : {}),
    },
  });
  return toUserDto(updated);
}

/** 重置教师密码（未指定时用默认初始密码） */
export async function resetTeacherPassword(
  teacherId: string,
  input: ResetTeacherPasswordInput,
): Promise<void> {
  const teacher = await findTeacherOrThrow(teacherId);
  await prisma.user.update({
    where: { id: teacher.id },
    data: { passwordHash: await hashPassword(input.newPassword ?? env.defaultTeacherPassword) },
  });
}

/**
 * 删除教师账号。
 *
 * 安全护栏：教师是**班级共享内容**的创建者，而下面这些外键都是 `onDelete: Cascade`，
 * 删除账号会连带删掉整份内容（不是"作者名变空"，是内容真的没了）：
 *
 * | 关系 | 后果 |
 * | ---- | ---- |
 * | `Class.teacherId` | 整个班级（含课表/作业/通知/成绩）被删 |
 * | `Course.teacherId` | 该教师名下课程被删 |
 * | `ClassTeacher.teacherId` | 仅协作关系（无害，但一并列出以免漏项） |
 * | `Homework.createdBy` | **该教师发布过的全部作业被删** |
 * | `Notification.createdBy` | **该教师发布过的全部通知被删**（含"叫人"消息） |
 *
 * 前三条历史上被检查过，后两条（Homework / Notification）曾漏检 —— 于是"班主任转给别人 →
 * 不在任何协作班级 → 名下无课程"的账号会被放行，删除时静默清掉他在各班发过的作业与通知。
 * **改 schema 时请回到本函数核对一遍**：任何新增的"指向 User 且 Cascade"的关系都要加到这里
 * （`HomeworkStatus` / `NotificationRead` / `Grade` / `Enrollment` 的 `userId` 属于个人数据，
 * 随账号删除是正确行为，不算漏项）。
 *
 * 因此只有"没有留下任何班级共享内容"的账号才允许删除（实践中就是刚录入错的那条），
 * 否则返回 409 让管理员先转移/清理。
 */
export async function deleteTeacher(userId: string): Promise<void> {
  const teacher = await findTeacherOrThrow(userId);

  const [ownedClasses, assignedClasses, courses, homeworks, notifications] = await Promise.all([
    prisma.class.count({ where: { teacherId: teacher.id } }),
    prisma.classTeacher.count({ where: { teacherId: teacher.id } }),
    prisma.course.count({ where: { teacherId: teacher.id } }),
    prisma.homework.count({ where: { createdBy: teacher.id } }),
    prisma.notification.count({ where: { createdBy: teacher.id } }),
  ]);
  if (ownedClasses > 0) {
    throw ApiError.conflict(
      `「${teacher.name}」还是 ${ownedClasses} 个班级的班主任，请先在班级管理里更换班主任再删除`,
    );
  }
  if (homeworks > 0 || notifications > 0) {
    throw ApiError.conflict(
      `「${teacher.name}」发布过 ${homeworks} 条作业 / ${notifications} 条通知，` +
        '删除账号会连带删除这些内容，请先删除内容或改为保留账号',
    );
  }
  if (assignedClasses > 0 || courses > 0) {
    throw ApiError.conflict(
      `「${teacher.name}」还有 ${assignedClasses} 条班级分配 / ${courses} 门课程，请先解除后再删除`,
    );
  }

  await prisma.user.delete({ where: { id: teacher.id } });
}
