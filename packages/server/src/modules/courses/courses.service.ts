import type { CourseDto } from '@classhelper/shared';
import { assertCanManageSchedule, classScopeWhere, resolveClassScope } from '../../lib/access.js';
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
  await assertCanManageSchedule(user, input.classId);

  /*
   * 同名去重（一个班级里科目名唯一）。
   *
   * 这条不是"友好提示"，是**权限护栏**：`course.create` 会把创建者写成这门课的任课老师，
   * 于是只要能再建一门同名的「数学」，创建者就凭空成了「数学」的老师 ——
   * 后面那道 `assertCanManageSubjectContent` 的科目门随即形同虚设
   * （可以布置该科作业、录入该科成绩、删该科内容）。这就是"非该科科任老师
   * 能布置其他科作业"的入口。
   *
   * 处理办法是把**已有**课程的 id 回给前端（409 + details.courseId），让前端复用它；
   * 权限判定于是回到"你是不是这门课的任课老师"这个唯一事实上。
   */
  const existing = await prisma.course.findFirst({
    where: { classId: input.classId, name: input.name },
    select: { id: true },
  });
  if (existing) {
    throw new ApiError(409, 'COURSE_EXISTS', `该班级已有名为「${input.name}」的课程`, {
      courseId: existing.id,
    });
  }

  const created = await prisma.course.create({
    data: {
      name: input.name,
      initial: input.initial || Array.from(input.name)[0] || '',
      isOutDoor: input.isOutDoor ?? false,
      classId: input.classId,
      teacherId: user.sub,
    },
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
  await assertCanManageSchedule(user, course.classId);

  const updated = await prisma.course.update({
    where: { id: courseId },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.initial !== undefined ? { initial: input.initial } : {}),
      ...(input.isOutDoor !== undefined ? { isOutDoor: input.isOutDoor } : {}),
    },
    include: { teacher: teacherSelect },
  });
  return toCourseDto(updated);
}

export async function deleteCourse(user: TokenPayload, courseId: string): Promise<void> {
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) throw ApiError.notFound('课程不存在');
  await assertCanManageSchedule(user, course.classId);
  await prisma.course.delete({ where: { id: courseId } });
}
