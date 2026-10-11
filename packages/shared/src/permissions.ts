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

/* -------------------------------------------------------------------------- */
/*  权限键目录（权限组的唯一事实来源）                                          */
/* -------------------------------------------------------------------------- */

/**
 * 权限键：三端共用的**唯一权限标识**。
 *
 * - 服务端：路由级用 `requirePermission(key)`，班级维度的细门仍走下面那些
 *   `canXxx`（科目归属这类**数据完整性**规则故意不可被权限组覆盖）；
 * - Web 管理端：按钮/菜单显隐、权限组管理页的勾选项；
 * - 桌面客户端：功能入口显隐。
 *
 * 键名用 `领域:动作` 的形式，新增功能要**先在这里加键**，再去两端用。
 * **不要**在页面或服务里硬编码角色判断来代替它（AGENTS.md §5 第 3 条）。
 */
export const PERMISSION_KEYS = [
  // 班级与人员
  'class:read',
  'class:manage',
  'roster:manage',
  'teacher:manage',
  'schedule:read',
  'schedule:write',
  // 内容发布
  'homework:read',
  'homework:write',
  'notification:read',
  'notification:publish',
  'notification:delete',
  'call:create',
  // 成绩与导入
  'grade:read',
  'grade:write',
  'grade:import',
  'student:grade-query',
  'import:students',
  'import:teachers',
  'import:schedule',
  'import:class-teachers',
  // 设备与联动
  'device:manage',
  'classisland:notify',
  'client:read',
  'client:manage',
  'client:update-push',
  'remote:control',
  // 学期与归档
  'term:read',
  'term:write',
  'archive:manage',
  'dashboard:read',
  // 系统与安全
  'database:manage',
  'update:check',
  'update:force',
  'ai:use',
  'ai:manage',
  'permission:manage',
  'system:manage',
  'log:read',
  'developer:mode',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/** 权限键的中文名（权限组管理页与文档展示，别再各写一份） */
export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  'class:read': '查看班级与班级列表',
  'class:manage': '创建 / 修改 / 删除班级（含班级账号密码）',
  'roster:manage': '学生名单管理（增删 / 调班 / 导入）',
  'teacher:manage': '教师账号管理（新建 / 导入 / 重置密码 / 删除）',
  'schedule:read': '查看课表',
  'schedule:write': '课表与课程编辑',
  'homework:read': '查看作业',
  'homework:write': '发布 / 修改 / 删除作业（仍按任教科目录入）',
  'notification:read': '查看通知',
  'notification:publish': '发布通知',
  'notification:delete': '删除通知',
  'call:create': '叫人',
  'grade:read': '查看成绩与成绩汇总',
  'grade:write': '录入 / 修改成绩（仍按任教科目录入）',
  'grade:import': '导入成绩',
  'student:grade-query': '按学号查询学生成绩明细',
  'import:students': '导入学生名单',
  'import:teachers': '导入教师名单',
  'import:schedule': '导入课表时间配置',
  'import:class-teachers': '导入班级任课关系',
  'device:manage': '联动设备管理（ClassIsland 设备令牌 / 课表上报）',
  'classisland:notify': '向 ClassIsland 下发提醒',
  'client:read': '查看 ClassHelper 客户端在线状态与版本',
  'client:manage': '管理客户端设备（改名 / 停用 / 删除）',
  'client:update-push': '向客户端统一下发更新',
  'remote:control': '远控客户端电脑（关机 / 重启 / 注销 / 锁屏）',
  'term:read': '查看学期周次',
  'term:write': '修改学期周次与开学日期',
  'archive:manage': '毕业归档',
  'dashboard:read': '查看统计看板',
  'database:manage': '数据库快照 / 导出 / 切库',
  'update:check': '检查服务端更新',
  'update:force': '强制检查更新（绕过缓存）',
  'ai:use': '使用大模型指令（一句话发布）',
  'ai:manage': '大模型设置（开关 / 服务地址 / 密钥 / 模型）',
  'permission:manage': '权限组与用户权限管理',
  'system:manage': '全局系统设置（含开发者模式）',
  'log:read': '查看服务端日志',
  'developer:mode': '开发者模式',
};

/** 权限组管理页的分组展示（只影响排序与标题，不改变语义） */
export const PERMISSION_CATEGORIES: readonly { title: string; keys: readonly PermissionKey[] }[] = [
  {
    title: '班级与人员',
    keys: ['class:read', 'class:manage', 'roster:manage', 'teacher:manage', 'schedule:read', 'schedule:write'],
  },
  {
    title: '内容发布',
    keys: [
      'homework:read',
      'homework:write',
      'notification:read',
      'notification:publish',
      'notification:delete',
      'call:create',
    ],
  },
  {
    title: '成绩与导入',
    keys: [
      'grade:read',
      'grade:write',
      'grade:import',
      'student:grade-query',
      'import:students',
      'import:teachers',
      'import:schedule',
      'import:class-teachers',
    ],
  },
  {
    title: '设备与联动',
    keys: ['device:manage', 'classisland:notify', 'client:read', 'client:manage', 'client:update-push', 'remote:control'],
  },
  { title: '学期与统计', keys: ['term:read', 'term:write', 'archive:manage', 'dashboard:read'] },
  {
    title: '系统与安全',
    keys: [
      'database:manage',
      'update:check',
      'update:force',
      'ai:use',
      'ai:manage',
      'permission:manage',
      'system:manage',
      'log:read',
      'developer:mode',
    ],
  },
];

/**
 * 每个权限键的**默认角色**（镜像改造前各路由的 `requireRole(...)`，逐条对齐）。
 *
 * 这是"没有分过任何权限组"时的回落模板：行为与权限组功能上线前完全一致。
 * 一旦管理员给某个账号分了组，生效集合就**只由组的并集决定**（可以比默认更少）。
 *
 * 注意 `CLASS_DEVICE` 不出现在任何默认里：班级端的能力由班级维度断言
 * （`canManageSubjectContent(..., { allowClassDevice })` 等）决定，不受权限组影响。
 */
export const PERMISSION_DEFAULT_ROLES: Record<PermissionKey, readonly UserRole[]> = {
  'class:read': ['ADMIN', 'TEACHER'],
  'class:manage': ['ADMIN'],
  'roster:manage': ['ADMIN', 'TEACHER'],
  'teacher:manage': ['ADMIN'],
  'schedule:read': ['ADMIN', 'TEACHER'],
  'schedule:write': ['ADMIN', 'TEACHER'],
  'homework:read': ['ADMIN', 'TEACHER'],
  'homework:write': ['ADMIN', 'TEACHER'],
  'notification:read': ['ADMIN', 'TEACHER'],
  'notification:publish': ['ADMIN', 'TEACHER'],
  'notification:delete': ['ADMIN', 'TEACHER'],
  'call:create': ['ADMIN', 'TEACHER'],
  'grade:read': ['ADMIN', 'TEACHER'],
  'grade:write': ['ADMIN', 'TEACHER'],
  'grade:import': ['ADMIN', 'TEACHER'],
  'student:grade-query': ['ADMIN', 'TEACHER'],
  'import:students': ['ADMIN', 'TEACHER'],
  'import:teachers': ['ADMIN'],
  'import:schedule': ['ADMIN', 'TEACHER'],
  'import:class-teachers': ['ADMIN'],
  'device:manage': ['ADMIN', 'TEACHER'],
  'classisland:notify': ['ADMIN', 'TEACHER'],
  'client:read': ['ADMIN', 'TEACHER'],
  'client:manage': ['ADMIN'],
  'client:update-push': ['ADMIN'],
  'remote:control': ['ADMIN'],
  'term:read': ['ADMIN', 'TEACHER'],
  'term:write': ['ADMIN'],
  'archive:manage': ['ADMIN'],
  'dashboard:read': ['ADMIN', 'TEACHER'],
  'database:manage': ['ADMIN'],
  'update:check': ['ADMIN', 'TEACHER'],
  'update:force': ['ADMIN'],
  'ai:use': ['ADMIN', 'TEACHER'],
  'ai:manage': ['ADMIN'],
  'permission:manage': ['ADMIN'],
  'system:manage': ['ADMIN'],
  'log:read': ['ADMIN'],
  'developer:mode': ['ADMIN'],
};

/** 全部权限键（管理员的生效集合；也用在校验 zod 的枚举上） */
export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_KEYS;

/**
 * 角色默认权限清单（由 {@link PERMISSION_DEFAULT_ROLES} 派生）。
 *
 * `ADMIN` 是全集（服务端还会强制补上 `permission:manage` / `system:manage`，防止把自己锁死）。
 */
export const ROLE_DEFAULT_PERMISSIONS: Record<UserRole, readonly PermissionKey[]> = {
  ADMIN: PERMISSION_KEYS,
  TEACHER: PERMISSION_KEYS.filter((key) => PERMISSION_DEFAULT_ROLES[key].includes('TEACHER')),
  CLASS_DEVICE: [],
};

/** 取某个角色的默认权限集合（无分组时的回落模板） */
export function defaultPermissionsForRole(role: UserRole): PermissionKey[] {
  return [...ROLE_DEFAULT_PERMISSIONS[role]];
}

/** 判断权限集合里是否有某个键（`Set` 或数组都接受） */
export function hasPermission(permissions: ReadonlySet<string> | readonly string[], key: PermissionKey): boolean {
  const list: readonly string[] = Array.isArray(permissions) ? permissions : [...permissions];
  return list.includes(key);
}

/** 判断是否含任意一个键（服务端 requirePermission 是"全部满足"，这里留给页面做"任一"判断） */
export function hasAnyPermission(
  permissions: ReadonlySet<string> | readonly string[],
  keys: readonly PermissionKey[],
): boolean {
  return keys.some((key) => hasPermission(permissions, key));
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
