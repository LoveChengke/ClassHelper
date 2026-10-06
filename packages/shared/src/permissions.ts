import type { UserRole } from './types.js';

/**
 * 班级内的角色（相对"某一个班级"而言）。
 *
 * - `ADMIN`        系统管理员：全部班级、全部科目
 * - `HEAD`         班主任（`Class.teacherId`）：本班学生名单、本班课表、本班汇总。
 *                  **不自动拥有本班所有科目的作业/成绩编辑权** —— 只有当他同时是
 *                  该科科任老师（`Course.teacherId === 他`）时才有那一科的权限。
 * - `SUBJECT`      科任老师（本班存在 `Course.teacherId === 他`）：只能动自己任教科目的作业与成绩
 * - `CLASS_DEVICE` ClassHelper 班级端（班级码 + 班级密码登录）：代本班读写个人数据
 * - `NONE`         与该班级无关
 */
export type ClassRole = 'ADMIN' | 'HEAD' | 'SUBJECT' | 'CLASS_DEVICE' | 'NONE';

export interface ClassRoleContext {
  role: UserRole;
  /** 是否是该班班主任（`Class.teacherId === 当前用户`） */
  isHeadTeacher?: boolean;
  /**
   * 是否在该班任教（该班存在 `Course.teacherId === 当前用户`）。
   *
   * 判定源是 **`Course`**（班级 + 科目 + 教师）这一条唯一的任课关系，
   * 不再是过去那张没有科目的 `ClassTeacher` 协作表。
   */
  teachesSubjects?: boolean;
}

/** 依据账号角色与该班归属关系，解析出班级内角色 */
export function resolveClassRole(context: ClassRoleContext): ClassRole {
  if (context.role === 'ADMIN') return 'ADMIN';
  if (context.role === 'CLASS_DEVICE') return 'CLASS_DEVICE';
  if (context.role === 'TEACHER') {
    // 班主任同时是科任老师时取更高的那一个；权限在下面各 canXxx 里合并，不会丢科任权限
    if (context.isHeadTeacher) return 'HEAD';
    if (context.teachesSubjects) return 'SUBJECT';
    return 'NONE';
  }
  return 'NONE';
}

/** 班级本身（创建/修改/删除）与人员分配：仅管理员 */
export function canManageClasses(role: UserRole): boolean {
  return role === 'ADMIN';
}

/** 班主任与科任老师的分配：仅管理员 */
export function canAssignTeachers(role: UserRole): boolean {
  return role === 'ADMIN';
}

/** 学生名单（增删学生、调班、导入名单）：管理员，或**本班班主任** */
export function canManageRoster(classRole: ClassRole): boolean {
  return classRole === 'ADMIN' || classRole === 'HEAD';
}

/** 课表管理：管理员或本班班主任（科任老师不可以） */
export function canManageSchedule(classRole: ClassRole): boolean {
  return classRole === 'ADMIN' || classRole === 'HEAD';
}

/** 课程（课表的前置数据）：与课表同权限 */
export function canManageCourses(classRole: ClassRole): boolean {
  return canManageSchedule(classRole);
}

/**
 * 发布通知 / 叫人：管理员、班主任、科任老师皆可。
 *
 * 通知与"叫人"是**面向全班**的信息，不像作业/成绩那样挂在某一科目上，
 * 因此凡是与本班有关联的教师（班主任或任课老师）都能发；ClassHelper 班级端也可以。
 */
export function canPublishNotification(classRole: ClassRole): boolean {
  return classRole === 'ADMIN' || classRole === 'HEAD' || classRole === 'SUBJECT' || classRole === 'CLASS_DEVICE';
}

/**
 * 成绩录入 / 修改 / 导入的**班级维度**准入：管理员，或**本班班主任**。
 *
 * 注意这只是第一道门：真正能不能动某一条成绩，还要看**科目**是否由他任教
 * （见服务端的 `assertCanManageCourseContent`）—— 班主任不教这一科就改不了这一科。
 */
export function canManageGrades(classRole: ClassRole): boolean {
  return classRole === 'ADMIN' || classRole === 'HEAD';
}

/**
 * 科目维度的写权限（作业与成绩共用的那道细门）：
 *
 * | 情形 | 谁可以写 |
 * | ---- | ---- |
 * | 管理员 | 全部 |
 * | ClassHelper 班级端 | 仅当传入 `allowClassDevice`（**作业**如此；成绩不给，与既有行为一致） |
 * | 作业/成绩**选了科目** | 该科的任课老师（`Course.teacherId`） |
 * | 作业/成绩**没选科目** | 本班班主任 |
 *
 * 这是需求「班主任不自动拥有所有科目作业成绩编辑权」的落点。
 */
export function canManageSubjectContent(input: {
  classRole: ClassRole;
  /** 目标是否挂在某个科目（Course）上 */
  hasSubject: boolean;
  /** 当前用户是否是该科目的任课老师 */
  isSubjectTeacherOfCourse: boolean;
  /**
   * 是否允许 ClassHelper 班级端代写。
   * 教室机器可以录**作业**（老师在教室随手录一条很常见，见 AGENTS.md §5 第 20 条），
   * 但**成绩**不给 —— 成绩是面向家长/学生的评价数据，仍由教师在 Web 端录入。
   */
  allowClassDevice?: boolean;
}): boolean {
  if (input.classRole === 'ADMIN') return true;
  if (input.classRole === 'CLASS_DEVICE') return input.allowClassDevice === true;
  if (input.hasSubject) return input.isSubjectTeacherOfCourse;
  return input.classRole === 'HEAD';
}

/**
 * 按学号查询学生成绩明细的准入。
 *
 * - 教师/管理员：班主任看本班、科任看本班、管理员看全部（都是"有权限就能看明细"）；
 * - ClassHelper 班级端：需要该班打开 `studentGradeQueryEnabled` —— 这就是
 *   「是否允许学生通过班级端查看本人明细，由教师或管理员开关控制」。
 */
export function canQueryStudentGrades(input: { classRole: ClassRole; gradeQueryEnabled: boolean }): boolean {
  if (input.classRole === 'ADMIN' || input.classRole === 'HEAD' || input.classRole === 'SUBJECT') return true;
  if (input.classRole === 'CLASS_DEVICE') return input.gradeQueryEnabled;
  return false;
}

/** 可导入的数据类型 */
export type ImportKind = 'grades' | 'students' | 'teachers' | 'classTeachers' | 'scheduleTimes';

/**
 * 导入权限：
 * - 学生名单 / 教师名单：`students` 允许管理员或本班班主任；`teachers` 仍仅管理员
 * - 成绩：管理员或本班班主任（再按科目收口）
 * - 班级任课老师：仅管理员（它直接改写班主任与任课关系）
 * - 课表时间：管理员或本班班主任
 */
export function canImport(role: UserRole, classRole: ClassRole, kind: ImportKind): boolean {
  if (kind === 'teachers' || kind === 'classTeachers') return canManageClasses(role);
  if (kind === 'students') return canManageRoster(classRole);
  if (kind === 'scheduleTimes') return canManageSchedule(classRole);
  return canManageGrades(classRole);
}

/** 人类可读的权限矩阵（README / 设置页展示，单一事实来源） */
export const PERMISSION_MATRIX: readonly {
  action: string;
  admin: boolean;
  head: boolean;
  subject: boolean;
  classDevice?: boolean;
}[] = [
  { action: '班级创建 / 修改 / 删除', admin: true, head: false, subject: false },
  { action: '分配班主任与各科科任老师', admin: true, head: false, subject: false },
  { action: '学生名单管理（增删 / 导入 / 调班）', admin: true, head: true, subject: false },
  { action: '教师录入（新建 / 导入名单 / 重置密码）', admin: true, head: false, subject: false },
  { action: '课表管理（增删改 / 时间配置导入）', admin: true, head: true, subject: false },
  { action: '布置作业（自己任教的科目）', admin: true, head: true, subject: true },
  { action: '叫人', admin: true, head: true, subject: true, classDevice: true },
  { action: '发布通知', admin: true, head: true, subject: true, classDevice: true },
  { action: '成绩录入 / 修改 / 导入（自己任教的科目）', admin: true, head: true, subject: true },
  { action: '查看本班成绩汇总', admin: true, head: true, subject: true },
  { action: '按学号查询学生成绩明细', admin: true, head: true, subject: true, classDevice: true },
  { action: '查看 ClassHelper 班级端在线状态', admin: true, head: true, subject: true },
];
