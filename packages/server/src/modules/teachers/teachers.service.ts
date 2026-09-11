import type { UserDto } from '@classhelper/shared';
import { prisma } from '../../lib/db.js';
import { toUserDto } from '../../lib/mappers.js';
import { hashPassword } from '../../lib/password.js';
import type { CreateTeacherInput } from './teachers.schemas.js';

/**
 * 教师列表：用于"分配协作教师"等需要选择教师的场景。
 * 仅返回教师/管理员账号，字段与 UserDto 对齐。
 */
export async function listTeachers(keyword?: string): Promise<UserDto[]> {
  const teachers = await prisma.user.findMany({
    where: {
      role: { in: ['TEACHER', 'ADMIN'] },
      ...(keyword ? { OR: [{ name: { contains: keyword } }, { username: { contains: keyword } }] } : {}),
    },
    orderBy: [{ role: 'asc' }, { username: 'asc' }],
    take: 200,
  });
  return teachers.map(toUserDto);
}

export async function createTeacher(input: CreateTeacherInput): Promise<UserDto> {
  const created = await prisma.user.create({
    data: {
      username: input.username,
      name: input.name,
      role: input.role ?? 'TEACHER',
      passwordHash: await hashPassword(input.password),
    },
  });
  return toUserDto(created);
}
