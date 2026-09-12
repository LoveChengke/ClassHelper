import type { UserRole } from './types.js';

/**
 * 班级内的角色（相对"某一个班级"而言）。
 *
 * - `ADMIN`   系统管理员：班级增删改、人员分配、全部数据
 * - `HEAD`    班主任（`Class.teacherId`）：本班课表 + 作业/通知/叫人
 * - `SUBJECT` 科任老师（`ClassTeacher`）：仅作业/通知/叫人
 * - `STUDENT` 学生（个人账号或班级账号）：只读
 * - `NONE`    与该班级无关
 */
export type ClassRole = 'ADMIN' | 'HEAD' | 'SUBJECT' | 'STUDENT' | 'NONE';

export interface ClassRoleContext {
  role: UserRole;
  /** 是否是该班班主任（Class.teacherId === 当前用户） */
  isHeadTeacher?: boolean;
  /** 是否被分配为该班科任/协作老师（ClassTeacher 中存在当前用户） */
  isSubjectTeacher?: boolean;
}

/** 依据账号角色与该班归属关系，解析出班级内角色 */
export function resolveClassRole(context: ClassRoleContext): ClassRole {
  if (context.role === 'ADMIN') return 'ADMIN';
  if (context.role === 'TEACHER') {
    if (context.isHeadTeacher) return 'HEAD';
    if (context.isSubjectTeacher) return 'SUBJECT';
    return 'NONE';
  }
  if (context.role === 'STUDENT') return 'STUDENT';
  return 'NONE';
}

/** 班级本身（创建/修改/删除）与人员分配：仅管理员 */
export function canManageClasses(role: UserRole): boolean {
  return role === 'ADMIN';
}

/** 班主任与科任老师名单的编辑：仅管理员 */
export function canAssignTeachers(role: UserRole): boolean {
  return role === 'ADMIN';
}

/** 学生名单（增删学生、重置密码、导入名单）：仅管理员 */
export function canManageRoster(role: UserRole): boolean {
  return role === 'ADMIN';
}

/** 课表管理：管理员或本班班主任（科任老师不可以） */
export function canManageSchedule(classRole: ClassRole): boolean {
  return classRole === 'ADMIN' || classRole === 'HEAD';
}

/** 课程（课表的前置数据）：与课表同权限 */
export function canManageCourses(classRole: ClassRole): boolean {
  return canManageSchedule(classRole);
}

/** 布置作业 / 叫人 / 发通知：管理员、班主任、科任老师皆可（学生不可） */
export function canPublishContent(classRole: ClassRole): boolean {
  return classRole === 'ADMIN' || classRole === 'HEAD' || classRole === 'SUBJECT';
}

/** 成绩录入/修改/导入：仅管理员（按需求 7 的权限清单） */
export function canManageGrades(role: UserRole): boolean {
  return role === 'ADMIN';
}

/** 可导入的数据类型 */
export type ImportKind = 'grades' | 'students' | 'scheduleTimes';

/** 导入权限：成绩=管理员；名单=管理员；课表时间=管理员或本班班主任 */
export function canImport(role: UserRole, classRole: ClassRole, kind: ImportKind): boolean {
  if (kind === 'scheduleTimes') return canManageSchedule(classRole);
  return canManageGrades(role);
}

/** 人类可读的权限矩阵（README / 设置页展示，单一事实来源） */
export const PERMISSION_MATRIX: readonly {
  action: string;
  admin: boolean;
  head: boolean;
  subject: boolean;
}[] = [
  { action: '班级创建 / 修改 / 删除', admin: true, head: false, subject: false },
  { action: '分配班主任与科任老师', admin: true, head: false, subject: false },
  { action: '学生名单管理（增删 / 重置密码 / 导入）', admin: true, head: false, subject: false },
  { action: '课表管理（增删改 / 时间配置导入）', admin: true, head: true, subject: false },
  { action: '布置作业', admin: true, head: true, subject: true },
  { action: '叫人', admin: true, head: true, subject: true },
  { action: '发布通知', admin: true, head: true, subject: true },
  { action: '成绩录入 / 修改 / 导入', admin: true, head: false, subject: false },
];
