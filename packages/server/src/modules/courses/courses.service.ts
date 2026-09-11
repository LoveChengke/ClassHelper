import type { CourseDto } from '@classhelper/shared';
import { assertClassWritable, classScopeWhere, resolveClassScope } from '../../lib/access.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import type { TokenPayload } from '../../lib/jwt.js';
import { toCourseDto } from '../../lib/mappers.js';
import type { CreateCourseInput, UpdateCourseInput } from './courses.schemas.js';

const teacherSelect = { select: { id: true, name: true, username: true } } as const;

export async function listCourses(user: TokenPayload, classId?: string): Promise<CourseDto[]> {
  const scope = await resolveClassScope(user, classId);
  const courses = await prisma.course.findMany({
    where: classScopeWhere(scope),
    include: { teacher: teacherSelect },
    orderBy: [{ classId: 'asc' }, { name: 'asc' }],
  });
  return courses.map(toCourseDto);
}

export async function createCourse(user: TokenPayload, input: CreateCourseInput): Promise<CourseDto> {
  await assertClassWritable(user, input.classId);

  const created = await prisma.course.create({
    data: { name: input.name, classId: input.classId, teacherId: user.sub },
    include: { teacher: teacherSelect },
  });
  return toCourseDto(created);
}

export async function updateCourse(
  user: TokenPayload,
  courseId: string,
  input: UpdateCourseInput,
): Promise<CourseDto> {
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) throw ApiError.notFound('课程不存在');
  await assertClassWritable(user, course.classId);

  const updated = await prisma.course.update({
    where: { id: courseId },
    data: { ...(input.name ? { name: input.name } : {}) },
    include: { teacher: teacherSelect },
  });
  return toCourseDto(updated);
}

export async function deleteCourse(user: TokenPayload, courseId: string): Promise<void> {
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) throw ApiError.notFound('课程不存在');
  await assertClassWritable(user, course.classId);
  await prisma.course.delete({ where: { id: courseId } });
}
