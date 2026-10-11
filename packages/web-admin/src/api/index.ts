import {
  API_PATHS,
  type AiAuditDto,
  type AiInterpretResult,
  type AiSettingsDto,
  type ApiErrorResponse,
  type ArchivedClassContentDto,
  type ArchivedYearDetailDto,
  type ArchivedYearDto,
  type AssignUserGroupsRequest,
  type ClassDetailDto,
  type ClassDto,
  type AutoTermWeeksRequest,
  type ClassHelperStatusListDto,
  type ClassPlanImportResultDto,
  type ClassPlanPreviewDto,
  type ClassStatusDto,
  type ClientDeviceDto,
  type ClientPushResult,
  type ClientReleaseDto,
  type CourseDto,
  type CreateArchiveRequest,
  type CreateCallRequest,
  type CreateClassRequest,
  type CreateClientCommandRequest,
  type CreateCourseRequest,
  type CreateGradeRequest,
  type CreateHomeworkRequest,
  type BulkCreateHomeworkRequest,
  type BulkCreateNotificationRequest,
  type BulkPublishResult,
  type NotificationCreatorsDto,
  type NotificationDaysDto,
  type CreateIntegrationDeviceRequest,
  type CreateNotificationRequest,
  type CreatePermissionGroupRequest,
  type CreateScheduleRequest,
  type CreateStudentRequest,
  type DashboardSummary,
  type DatabaseBackupMetaDto,
  type DatabaseBackupScheduleDto,
  type DatabaseConnectionTestDto,
  type DatabaseStatusDto,
  type DatabaseSwitchJobDto,
  type GradeDto,
  type GradeLevelType,
  type GradeStats,
  type HolidaySuggestionDto,
  type HomeworkDaysDto,
  type HomeworkDto,
  type HomeworkSubmissionsDto,
  type IntegrationDeviceDto,
  type IntegrationDeviceTokenDto,
  type LoginRequest,
  type LoginResponse,
  type MyPermissionsDto,
  type NotificationDto,
  type PaginatedResult,
  type PermissionCatalogDto,
  type PermissionGroupDto,
  type PermissionMemberDto,
  type PushClientUpdateRequest,
  type ScheduleDto,
  type ScheduleWeekView,
  type SendClassIslandNotificationRequest,
  type SendClassIslandNotificationResult,
  type SessionUser,
  type StudentDto,
  type StudentGradeDetailDto,
  type StudentStatus,
  type StudentTransferDto,
  type SubjectTeacherDto,
  type SystemDiagnosticsDto,
  type SystemSettingsDto,
  type TableImportPreview,
  type TableImportResult,
  type TermWeeksDto,
  type TimeLayoutDto,
  type TimeLayoutImportResult,
  type TimeLayoutParsePreview,
  type UpdateAiSettingsRequest,
  type UpdateClassAccountRequest,
  type UpdateClassRequest,
  type UpdateInfo,
  type UpdateIntegrationDeviceRequest,
  type UpdatePermissionGroupRequest,
  type UpdateStudentRequest,
  type UpdateTermWeeksRequest,
  type UserDto,
} from '@classhelper/shared';
import { api } from './http';

/* ------------------------------------------------------------------ 认证 */

export const authApi = {
  login: (payload: LoginRequest): Promise<LoginResponse> => api.post(API_PATHS.auth.login, payload),
  logout: (): Promise<{ loggedOut: boolean }> => api.post(API_PATHS.auth.logout, {}),
  /** 当前会话主体：教师/管理员是账号，ClassHelper 班级端是班级 */
  me: (): Promise<SessionUser> => api.get(API_PATHS.auth.me),
  changePassword: (payload: {
    currentPassword: string;
    newPassword: string;
  }): Promise<{ changed: boolean }> => api.patch(API_PATHS.auth.changePassword, payload),
};

/* ------------------------------------------------------------------ 班级 */

export const classApi = {
  list: (params?: { keyword?: string }): Promise<ClassDto[]> => api.get(API_PATHS.classes, params),
  detail: (id: string): Promise<ClassDetailDto> => api.get(`${API_PATHS.classes}/${id}`),
  create: (payload: CreateClassRequest): Promise<ClassDto> => api.post(API_PATHS.classes, payload),
  update: (id: string, payload: UpdateClassRequest): Promise<ClassDto> =>
    api.patch(`${API_PATHS.classes}/${id}`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.classes}/${id}`),
  students: (id: string): Promise<StudentDto[]> => api.get(`${API_PATHS.classes}/${id}/students`),
  addStudent: (
    id: string,
    payload: { studentNo: string; name: string; gender?: string; guardianPhone?: string },
  ): Promise<StudentDto> => api.post(`${API_PATHS.classes}/${id}/students`, payload),
  removeStudent: (id: string, studentId: string): Promise<unknown> =>
    api.delete(`${API_PATHS.classes}/${id}/students/${studentId}`),
  /** 设置 / 更改班主任（每班 1 人）：仅管理员 */
  assignHeadTeacher: (id: string, teacherId: string): Promise<ClassDto> =>
    api.patch(`${API_PATHS.classes}/${id}/head-teacher`, { teacherId }),
  /**
   * 设置各科任课老师（班级 + 科目 + 教师）：仅管理员。
   * 这是「科任老师」这条关系的唯一写入口。
   */
  assignSubjectTeachers: (
    id: string,
    assignments: Array<{ courseId?: string | null; subjectName: string; teacherId?: string | null }>,
  ): Promise<SubjectTeacherDto[]> =>
    api.put(`${API_PATHS.classes}/${id}/subject-teachers`, { assignments }),
  /** 设置 / 重置班级账号（班级码 + 班级密码）：仅管理员 */
  updateAccount: (id: string, payload: UpdateClassAccountRequest): Promise<ClassDto> =>
    api.patch(`${API_PATHS.classes}/${id}/class-account`, payload),
  /** 班级端按学号查成绩的开关 */
  getGradeQuery: (id: string): Promise<{ studentGradeQueryEnabled: boolean }> =>
    api.get(`${API_PATHS.classes}/${id}/student-grade-query`),
  setGradeQuery: (id: string, enabled: boolean): Promise<{ studentGradeQueryEnabled: boolean }> =>
    api.patch(`${API_PATHS.classes}/${id}/student-grade-query`, { enabled }),
  /** 学年升级：只改年级，不归档、数据沿用 */
  promote: (classIds: string[], grade: string): Promise<{ promoted: number }> =>
    api.post(`${API_PATHS.classes}/promote`, { classIds, grade }),
};

/* ------------------------------------------------------------------ 课程 */

export const courseApi = {
  list: (classId?: string): Promise<CourseDto[]> =>
    api.get(API_PATHS.courses, classId ? { classId } : undefined),
  create: (payload: CreateCourseRequest): Promise<CourseDto> => api.post(API_PATHS.courses, payload),
  update: (id: string, payload: { name: string }): Promise<CourseDto> =>
    api.patch(`${API_PATHS.courses}/${id}`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.courses}/${id}`),
};

/**
 * 从「同名课程已存在」的失败里取出那门已有课程的 id。
 *
 * 服务端对 `POST /courses` 做了 (班级 + 科目名) 去重（返回 409 `COURSE_EXISTS` +
 * `details.courseId`），因为课程创建会把创建者写成任课老师 —— 若放行同名第二门课，
 * 谁都能借"新建科目"把自己变成别人的科目的老师，绕过科目维度的写权限。
 * 前端拿到这个 id 就**复用既有课程**：权限判定随即回到"你是不是这门课的老师"，
 * 该 403 的地方就 403（而不是悄悄多出一门归属自己的同名课）。
 */
export function courseIdFromExistsError(error: unknown): string | null {
  const data = (error as { response?: { data?: ApiErrorResponse } })?.response?.data;
  if (!data || data.code !== 'COURSE_EXISTS') return null;
  const details = data.details as { courseId?: unknown } | null | undefined;
  return typeof details?.courseId === 'string' ? details.courseId : null;
}

/* ------------------------------------------------------------------ 课表 */

export const scheduleApi = {
  list: (params: { classId?: string; week?: number; dayOfWeek?: number }): Promise<ScheduleDto[]> =>
    api.get(API_PATHS.schedules, params),
  grid: (params: { classId?: string; week?: number }): Promise<ScheduleWeekView> =>
    api.get(`${API_PATHS.schedules}/grid`, params),
  /** 班级当前上课状态：上课时段发布紧急通知时必须先二次确认 */
  classStatus: (classId: string): Promise<ClassStatusDto> =>
    api.get(`${API_PATHS.schedules}/current`, { classId }),
  create: (payload: CreateScheduleRequest): Promise<ScheduleDto> => api.post(API_PATHS.schedules, payload),
  update: (id: string, payload: Partial<CreateScheduleRequest>): Promise<ScheduleDto> =>
    api.patch(`${API_PATHS.schedules}/${id}`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.schedules}/${id}`),
};

/* ------------------------------------------------------------------ 作业 */

export const homeworkApi = {
  list: (params: {
    classId?: string;
    courseId?: string;
    pendingOnly?: boolean;
    keyword?: string;
    /** 只看某一天（YYYY-MM-DD，按作业所属日期） */
    date?: string;
  }): Promise<HomeworkDto[]> => api.get(API_PATHS.homeworks, params),
  /** 哪些天有作业（日期选择器高亮） */
  days: (params: { classId?: string; from?: string; to?: string; days?: number }): Promise<HomeworkDaysDto> =>
    api.get(`${API_PATHS.homeworks}/days`, params),
  detail: (id: string): Promise<HomeworkDto> => api.get(`${API_PATHS.homeworks}/${id}`),
  create: (payload: CreateHomeworkRequest): Promise<HomeworkDto> => api.post(API_PATHS.homeworks, payload),
  /** 一次给多个班级布置同一份作业（服务端逐班判定并返回逐班结果） */
  bulkCreate: (payload: BulkCreateHomeworkRequest): Promise<BulkPublishResult> =>
    api.post(`${API_PATHS.homeworks}/bulk`, payload),
  update: (id: string, payload: Partial<CreateHomeworkRequest>): Promise<HomeworkDto> =>
    api.patch(`${API_PATHS.homeworks}/${id}`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.homeworks}/${id}`),
  /** 提交名单 / 未交名单（教师与 ClassHelper 班级端可用） */
  submissions: (id: string): Promise<HomeworkSubmissionsDto> =>
    api.get(`${API_PATHS.homeworks}/${id}/submissions`),
  saveSubmissions: (id: string, notSubmittedStudentIds: string[]): Promise<HomeworkSubmissionsDto> =>
    api.patch(`${API_PATHS.homeworks}/${id}/submissions`, { notSubmittedStudentIds }),
};

/* ------------------------------------------------------------------ 通知 */

export const notificationApi = {
  list: (params: {
    classId?: string;
    priority?: string;
    unreadOnly?: boolean;
    keyword?: string;
    /** 只看某一天（YYYY-MM-DD，按通知所属日期 assignDate） */
    date?: string;
    /** 日期区间（含边界） */
    from?: string;
    to?: string;
    /** 只看某位发布人 */
    createdBy?: string;
  }): Promise<NotificationDto[]> => api.get(API_PATHS.notifications, params),
  /** 按天归档：有通知的日期 + 当天条数 */
  days: (params: {
    classId?: string;
    priority?: string;
    createdBy?: string;
    from?: string;
    to?: string;
  }): Promise<NotificationDaysDto> => api.get(`${API_PATHS.notifications}/days`, params),
  /** 按发布人归档：发布人 + 各人的通知条数 */
  creators: (params: {
    classId?: string;
    priority?: string;
    date?: string;
    from?: string;
    to?: string;
  }): Promise<NotificationCreatorsDto> => api.get(`${API_PATHS.notifications}/creators`, params),
  create: (payload: CreateNotificationRequest): Promise<NotificationDto> =>
    api.post(API_PATHS.notifications, payload),
  /** 一次给多个班级发同一条通知（服务端逐班判定并返回逐班结果） */
  bulkCreate: (payload: BulkCreateNotificationRequest): Promise<BulkPublishResult> =>
    api.post(`${API_PATHS.notifications}/bulk`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.notifications}/${id}`),
  unreadCount: (classId?: string): Promise<{ count: number }> =>
    api.get(`${API_PATHS.notifications}/unread-count`, classId ? { classId } : undefined),
};

/* ------------------------------------------------------------------ 叫人 */

export const callApi = {
  /** 点名让学生来找老师（ClassHelper 班级端灵动岛会立即弹出"请 XXX 同学找 XXX 老师"） */
  create: (payload: CreateCallRequest): Promise<NotificationDto> => api.post(API_PATHS.calls, payload),
};

/* ------------------------------------------------------------------ 成绩 */

export const gradeApi = {
  list: (params: {
    classId?: string;
    courseId?: string;
    /** 学生 id（学生是名单记录，不是账号） */
    studentId?: string;
    examName?: string;
  }): Promise<GradeDto[]> => api.get(API_PATHS.grades, params),
  stats: (params: { classId?: string; courseId?: string; examName?: string }): Promise<GradeStats> =>
    api.get(`${API_PATHS.grades}/stats`, params),
  create: (payload: CreateGradeRequest): Promise<GradeDto> => api.post(API_PATHS.grades, payload),
  bulkCreate: (payload: {
    classId: string;
    courseId?: string | null;
    examName: string;
    totalScore?: number;
    levelType?: GradeLevelType;
    publishedAt?: string | null;
    items: Array<{ studentId: string; score: number; level?: string }>;
  }): Promise<{ count: number; items: GradeDto[] }> => api.post(`${API_PATHS.grades}/bulk`, payload),
  update: (id: string, payload: Partial<CreateGradeRequest>): Promise<GradeDto> =>
    api.patch(`${API_PATHS.grades}/${id}`, payload),
  /** 批量改等级：逐条指定；或整批重算（classId + examName + levelType） */
  updateLevels: (
    payload:
      | { items: Array<{ id: string; level: string }> }
      | { classId: string; examName: string; courseId?: string | null; levelType: GradeLevelType },
  ): Promise<{ updated: number }> => api.patch(`${API_PATHS.grades}/levels`, payload),
  /** 按**学号**查某个学生的成绩明细（教师端"按学号查成绩"） */
  studentDetail: (studentNo: string, classId?: string): Promise<StudentGradeDetailDto> =>
    api.get(`${API_PATHS.grades}/student/${encodeURIComponent(studentNo)}`, classId ? { classId } : undefined),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.grades}/${id}`),
};

/* ------------------------------------------------------------------ 学生 */

// 学生是「名单记录」不是「账号」：没有密码相关接口，登录统一走班级码 + 班级密码。
// 学号（studentNo）是学生的唯一标识与查询键。
export const studentApi = {
  list: (params?: {
    classId?: string;
    keyword?: string;
    status?: StudentStatus;
    includeArchived?: boolean;
  }): Promise<StudentDto[]> => api.get(API_PATHS.students, params),
  create: (payload: CreateStudentRequest): Promise<StudentDto> => api.post(API_PATHS.students, payload),
  update: (id: string, payload: UpdateStudentRequest): Promise<StudentDto> =>
    api.patch(`${API_PATHS.students}/${id}`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.students}/${id}`),
  /** 调班：单个与批量同一接口（studentIds 长度 1 即单个）；学号不变、历史可查 */
  transfer: (studentIds: string[], toClassId: string | null, note?: string): Promise<{ moved: number }> =>
    api.post(`${API_PATHS.students}/transfer`, { studentIds, toClassId, note }),
  /** 转出（学籍离开本校，不是调班） */
  transferOut: (studentIds: string[], note?: string): Promise<{ transferred: number }> =>
    api.post(`${API_PATHS.students}/transfer-out`, { studentIds, note }),
  /** 某个学生的调班 / 转出历史 */
  transfersOf: (id: string): Promise<PaginatedResult<StudentTransferDto>> =>
    api.get(`${API_PATHS.students}/${id}/transfers`),
  /** 调班历史（可按学生或班级过滤） */
  transfers: (params?: {
    studentId?: string;
    classId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<PaginatedResult<StudentTransferDto>> => api.get(`${API_PATHS.students}/transfers`, params),
};

/* ------------------------------------------------------------------ 仪表盘 */

export const dashboardApi = {
  summary: (): Promise<DashboardSummary> => api.get(API_PATHS.dashboard),
  /**
   * 学期信息：`maxWeek` 是该班的教学周数（`Class.termWeeks`，班主任可调，默认 20），
   * 不带 classId 时后端回退全局默认值。
   */
  term: (classId?: string): Promise<{ currentWeek: number; maxWeek: number }> =>
    api.get('/dashboard/term', classId ? { classId } : undefined),
};

/* ------------------------------------------------------------------ 教师管理（仅管理员） */

/** 教师的 `username` 就是**工号**（也是登录名），界面上统一叫「工号」 */
export const teacherApi = {
  list: (keyword?: string): Promise<UserDto[]> =>
    api.get(API_PATHS.teachers, keyword ? { keyword } : undefined),
  create: (payload: {
    username: string;
    name: string;
    phone?: string;
    password?: string;
    role?: 'TEACHER' | 'ADMIN';
  }): Promise<UserDto> => api.post(API_PATHS.teachers, payload),
  update: (
    id: string,
    payload: { username?: string; name?: string; phone?: string; role?: 'TEACHER' | 'ADMIN' },
  ): Promise<UserDto> => api.patch(`${API_PATHS.teachers}/${id}`, payload),
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.teachers}/${id}`),
  resetPassword: (id: string, newPassword?: string): Promise<unknown> =>
    api.post(`${API_PATHS.teachers}/${id}/reset-password`, newPassword ? { newPassword } : {}),
};

/* ------------------------------------------------------------------ 毕业归档（仅管理员） */

/**
 * 归档是**打标记 + 只读**，不删数据：毕业班级的作业与通知原样留在库里，
 * 通过 `classContent()` 只读查看。「未毕业而升级的班级不归档」走 `classApi.promote`。
 */
export const archiveApi = {
  list: (): Promise<ArchivedYearDto[]> => api.get(API_PATHS.archives),
  summary: (): Promise<{
    archiveCount: number;
    classCount: number;
    graduateCount: number;
    transferredCount: number;
    suggestedEnrollmentYears: number[];
  }> => api.get(`${API_PATHS.archives}/summary`),
  detail: (id: string): Promise<ArchivedYearDetailDto> => api.get(`${API_PATHS.archives}/${id}`),
  /** 归档班级的作业与通知（只读） */
  classContent: (id: string, classId: string, limit = 200): Promise<ArchivedClassContentDto> =>
    api.get(`${API_PATHS.archives}/${id}/classes/${classId}/content`, { limit }),
  create: (payload: CreateArchiveRequest): Promise<ArchivedYearDetailDto> =>
    api.post(API_PATHS.archives, payload),
  /** 撤销归档（误操作的退路，不删任何数据） */
  remove: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.archives}/${id}`),
};

/* ------------------------------------------------------------------ 学期周次（仅管理员可写） */

/**
 * 学期周次：逐周指定实际的起止日期。
 *
 * 课表、作业、成绩都按教学周组织，而"开学日期 + 每周七天"的线性推算遇到调休、
 * 周末补课、错峰开学就会整体错位 —— 所以支持逐周配置。
 * `classId` 留空 = 全校默认；保存后变更会随课表下发给教室的 ClassHelper 班级端。
 */
export const termApi = {
  get: (classId?: string): Promise<TermWeeksDto> =>
    api.get(API_PATHS.term, classId ? { classId } : undefined),
  save: (payload: UpdateTermWeeksRequest): Promise<TermWeeksDto> => api.put(API_PATHS.term, payload),
  /** 按学期开始日期一键生成逐周区间（配置的起点） */
  auto: (payload: AutoTermWeeksRequest): Promise<TermWeeksDto> => api.post(`${API_PATHS.term}/auto`, payload),
  /** 联网获取法定节假日安排（只给建议；机房没外网时 ok=false 属正常） */
  holidays: (year?: number): Promise<HolidaySuggestionDto> =>
    api.get(`${API_PATHS.term}/holidays`, year ? { year } : undefined),
};

/* ------------------------------------------------------------------ 导入（模板 / 表格 / 课表时间配置 / ClassIsland 课程表） */

type TableKind = 'grades' | 'students' | 'teachers' | 'classTeachers';

export const importApi = {
  /** 模板下载地址（CSV 走 JSON，XLSX 走二进制） */
  template: (
    kind: TableKind,
    format: 'csv' | 'xlsx' = 'csv',
  ): Promise<{ kind: string; format: string; fileName: string; content: string }> =>
    api.get(`${API_PATHS.imports}/template`, { kind, format }),

  /** 上传表格并预览（解析 + 必填列校验 + 建议映射，不写库） */
  previewTable: (payload: {
    kind: TableKind;
    fileName: string;
    contentBase64: string;
  }): Promise<TableImportPreview> => api.post(`${API_PATHS.imports}/table/preview`, payload),

  /** 确认字段映射与写入模式后执行导入（教师名单与班级无关，classId 可省略） */
  commitTable: (payload: {
    kind: TableKind;
    classId?: string;
    fileName: string;
    contentBase64: string;
    mapping: Record<string, string>;
    mode: 'append' | 'upsert';
    /** 班级任课老师导入：是否用「工号」匹配已有教师账号 */
    useTeacherNo?: boolean;
  }): Promise<TableImportResult> => api.post(`${API_PATHS.imports}/table/commit`, payload),

  /** ClassIsland 时间配置解析预览（不写库） */
  previewTimeLayout: (payload: {
    classId: string;
    name?: string;
    mode?: 'replace' | 'merge';
    payload: unknown;
  }): Promise<TimeLayoutParsePreview> => api.post(`${API_PATHS.imports}/time-layout/preview`, payload),

  /** 某班已导入的时间配置 */
  listTimeLayouts: (classId: string): Promise<TimeLayoutDto[]> =>
    api.get(`${API_PATHS.imports}/time-layout`, { classId }),

  /** 导入（覆盖或合并；解析失败返回 400 且不改动原配置） */
  importTimeLayout: (payload: {
    classId: string;
    name?: string;
    mode: 'replace' | 'merge';
    payload: unknown;
  }): Promise<TimeLayoutImportResult> => api.post(`${API_PATHS.imports}/time-layout`, payload),

  removeTimeLayout: (id: string): Promise<{ id: string }> =>
    api.delete(`${API_PATHS.imports}/time-layout/${id}`),

  /**
   * ClassIsland 课程表（ClassPlan）解析预览（不写库）。
   * 注意：请求体里的 JSON 字段名就叫 payload（与 ClassIsland 档案 JSON 同名）。
   */
  previewClassPlan: (payload: {
    classId: string;
    mode?: 'replace' | 'merge';
    payload: unknown;
  }): Promise<ClassPlanPreviewDto> => api.post(`${API_PATHS.imports}/class-plan/preview`, payload),

  /** 导入 ClassIsland 课程表（支持单双周：replace 覆盖 / merge 合并；失败会抛错且不改动原课表） */
  importClassPlan: (payload: {
    classId: string;
    mode?: 'replace' | 'merge';
    payload: unknown;
  }): Promise<ClassPlanImportResultDto> => api.post(`${API_PATHS.imports}/class-plan`, payload),
};

/* ------------------------------------------------------------------ ClassIsland 联动 */

/**
 * 联动设备管理 + 提醒下发。
 *
 * 设备令牌（chci_...）只在**创建**与**重置**两个接口的返回值里出现一次，
 * 其余接口永远只回 tokenHint（前缀提示），因此拿到 token 后要立刻提示老师复制保存。
 */
export const integrationApi = {
  listDevices: (classId?: string): Promise<IntegrationDeviceDto[]> =>
    api.get(`${API_PATHS.integrations}/devices`, classId ? { classId } : undefined),
  createDevice: (payload: CreateIntegrationDeviceRequest): Promise<IntegrationDeviceTokenDto> =>
    api.post(`${API_PATHS.integrations}/devices`, payload),
  updateDevice: (id: string, payload: UpdateIntegrationDeviceRequest): Promise<IntegrationDeviceDto> =>
    api.patch(`${API_PATHS.integrations}/devices/${id}`, payload),
  /** 重置令牌：旧令牌立即失效，插件需要重新填写 */
  resetToken: (id: string): Promise<IntegrationDeviceTokenDto> =>
    api.post(`${API_PATHS.integrations}/devices/${id}/token`, {}),
  removeDevice: (id: string): Promise<{ id: string }> =>
    api.delete(`${API_PATHS.integrations}/devices/${id}`),
  /**
   * 「**从教室机器获取一次课表**」：置一个待办，插件在下一次心跳把当前课表推上来。
   *
   * 自动回传（`syncScheduleToServer`）现在默认关闭 —— 它会在老师手排课之后
   * 被教室的旧课表悄悄覆盖。要取教室的课表就点这个按钮（前端会先弹警告）。
   */
  requestSchedule: (id: string): Promise<{ requested: boolean; deviceName: string; nextHeartbeatHint: string }> =>
    api.post(`${API_PATHS.integrations}/devices/${id}/request-schedule`, {}),
  /** 把一条提醒下发到该班的 ClassIsland 设备（ClassIsland 上全屏弹出） */
  notify: (payload: SendClassIslandNotificationRequest): Promise<SendClassIslandNotificationResult> =>
    api.post(`${API_PATHS.integrations}/classisland/notify`, payload),
  /**
   * **ClassHelper 班级端在线状态**：管理员看全部班级，教师看自己班主任/任课的班级。
   * 每条含班级、设备名/设备号、在线离线、最后在线时间、最后心跳时间。
   */
  classHelperStatus: (): Promise<ClassHelperStatusListDto> =>
    api.get(`${API_PATHS.integrations}/classisland/status`),
};

/* ------------------------------------------------------------------ 数据库管理（仅管理员） */

/**
 * 数据库管理：状态 / 连接测试 / 备份 / 导入导出 / 定时备份 / 一键切换。
 *
 * 「快照下载」与「数据库文件下载」是二进制流，走 http.ts 的 download()（返回 Blob），
 * 由页面负责触发浏览器保存；导入把快照 JSON 转 base64 放进请求体（受 12MB 请求体限制）。
 */
export const databaseApi = {
  status: (): Promise<DatabaseStatusDto> => api.get(`${API_PATHS.database}/status`),
  testConnection: (payload: {
    provider: 'sqlite' | 'mysql';
    url: string;
  }): Promise<DatabaseConnectionTestDto> => api.post(`${API_PATHS.database}/test-connection`, payload),
  listBackups: (): Promise<DatabaseBackupMetaDto[]> => api.get(`${API_PATHS.database}/backups`),
  createBackup: (): Promise<DatabaseBackupMetaDto> => api.post(`${API_PATHS.database}/backups`, {}),
  restoreBackup: (name: string): Promise<{ counts: Record<string, number> }> =>
    api.post(`${API_PATHS.database}/backups/${encodeURIComponent(name)}/restore`, {}),
  deleteBackup: (name: string): Promise<{ name: string }> =>
    api.delete(`${API_PATHS.database}/backups/${encodeURIComponent(name)}`),
  importSnapshot: (base64: string): Promise<{ counts: Record<string, number> }> =>
    api.post(`${API_PATHS.database}/import`, { data: base64 }),
  /** 下载当前库的 JSON 快照（Blob，页面触发浏览器保存） */
  downloadSnapshot: (): Promise<Blob> => api.download(`${API_PATHS.database}/export`),
  /** 下载数据库文件（仅 SQLite 模式；MySQL 无单文件概念） */
  downloadSqliteFile: (): Promise<Blob> => api.download(`${API_PATHS.database}/sqlite-file`),
  getSchedule: (): Promise<DatabaseBackupScheduleDto> => api.get(`${API_PATHS.database}/backup-schedule`),
  saveSchedule: (payload: DatabaseBackupScheduleDto): Promise<DatabaseBackupScheduleDto> =>
    api.put(`${API_PATHS.database}/backup-schedule`, payload),
  startSwitch: (payload: { provider: 'sqlite' | 'mysql'; url: string }): Promise<{ jobId: string }> =>
    api.post(`${API_PATHS.database}/switch`, payload),
  getSwitchJob: (jobId: string): Promise<DatabaseSwitchJobDto | null> =>
    api.get(`${API_PATHS.database}/switch/jobs/${encodeURIComponent(jobId)}`),
};

/**
 * 更新检查：问服务端 GitHub 上有没有比本机新的版本。
 *
 * **Web 端不直连 GitHub** —— 服务端下发的 CSP `connect-src` 只放行 `'self'` 与 WebSocket
 * （见 `middleware/security.ts`），浏览器直连 `api.github.com` 会被拦掉；
 * 走服务端转发还顺带让所有管理员共享同一份缓存（匿名限流 60 次/小时/IP）。
 *
 * `ok:false` 是正常结果（机房没外网 / GitHub 限流），不是异常。
 */
export const updateApi = {
  /** @param force 绕过服务端缓存；仅管理员生效 */
  check: (force = false): Promise<UpdateInfo> =>
    api.get(`${API_PATHS.update}/check${force ? '?force=1' : ''}`),
};

/* ------------------------------------------------------------------ 权限组与用户权限 */

/**
 * 权限组管理（服务端 `modules/permissions`）。
 *
 * 权限生效规则：**有权限组时取各组的并集**（因此也能用来收回权限），
 * 没有任何组时回落到角色默认模板；管理员固定拥有全集，班级端不受权限组影响。
 *
 * 除 `me` 之外，本组接口都要求当前账号有 `permission:manage`（否则服务端 403）。
 */
export const permissionApi = {
  /** 当前账号的生效权限（任何登录账号都能读自己这一份） */
  me: (): Promise<MyPermissionsDto> => api.get(`${API_PATHS.permissions}/me`),
  /** 权限目录：全部键 / 中文名 / 分类 / 各键的默认角色 / 管理员不可剥夺的键 */
  catalog: (): Promise<PermissionCatalogDto> => api.get(`${API_PATHS.permissions}/catalog`),
  listGroups: (): Promise<PermissionGroupDto[]> => api.get(`${API_PATHS.permissions}/groups`),
  createGroup: (payload: CreatePermissionGroupRequest): Promise<PermissionGroupDto> =>
    api.post(`${API_PATHS.permissions}/groups`, payload),
  /** `keys` 传了就**整体替换**该组的权限键（不传则保持原样） */
  updateGroup: (id: string, payload: UpdatePermissionGroupRequest): Promise<PermissionGroupDto> =>
    api.patch(`${API_PATHS.permissions}/groups/${id}`, payload),
  /** 内置权限组不能删除（服务端会 400），调用前页面已经禁用了按钮 */
  removeGroup: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.permissions}/groups/${id}`),
  /** 可分配权限的成员（管理员与教师；管理员是固定行，不能分配） */
  listMembers: (): Promise<PermissionMemberDto[]> => api.get(`${API_PATHS.permissions}/users`),
  /** 分配权限组：传空数组 = 回到角色默认模板 */
  assignGroups: (userId: string, payload: AssignUserGroupsRequest): Promise<PermissionMemberDto> =>
    api.put(`${API_PATHS.permissions}/users/${userId}/groups`, payload),
};

/* ------------------------------------------------------------------ 客户端设备（远控与版本管理） */

/**
 * 「客户端设备」页的接口。
 *
 * 权限（与后端 `clients.module.ts` 逐个对齐）：
 * - `list` / `remove`：`client:manage`
 * - `commands`：`remote:control`（关机 / 重启 / 注销 / 锁屏，机器上还会再弹一次确认框）
 * - `pushUpdate`：`client:update-push`
 */
export const clientApi = {
  /** 设备列表（自动心跳上报产生的记录）；`classId` 留空 = 全部班级 */
  devices: (classId?: string): Promise<ClientDeviceDto[]> =>
    api.get(`${API_PATHS.clients}/devices`, classId ? { classId } : undefined),
  /**
   * 下发远控命令。
   *
   * 同一台机器上未执行的旧命令会被服务端**自动撤销**（否则"先关机、后重启"会排队执行）。
   */
  commands: (payload: CreateClientCommandRequest): Promise<ClientPushResult> =>
    api.post(`${API_PATHS.clients}/commands`, payload),
  /** 统一下发客户端更新：按设备 / 按班级 / 全部，或 `clear: true` 取消下发 */
  pushUpdate: (payload: PushClientUpdateRequest): Promise<ClientPushResult> =>
    api.post(`${API_PATHS.clients}/updates`, payload),
  /** 移除一台设备记录（换机 / 旧机器清理；只删记录，不影响那台机器本身） */
  removeDevice: (id: string): Promise<{ id: string }> => api.delete(`${API_PATHS.clients}/devices/${id}`),
};

/** GitHub 代下与「登记 → 校验 sha256」都可能要几十秒到几分钟，够长才不至于半路超时 */
const CLIENT_RELEASE_FETCH_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 客户端安装包缓存管理（服务端 `modules/update/client-releases.service.ts`）。
 *
 * 教室机器常常没有外网，所以安装包由**服务端替教室下载**再缓存：
 * Web 端不直连 GitHub（CSP 的 connect-src 只放行 self 与 WebSocket，见 AGENTS.md §5 第 52 条）。
 *
 * 权限：`list` 要 `client:manage`，`fetch` / `register` / `remove` 要 `client:update-push`。
 */
export const clientReleaseApi = {
  /** 服务端已缓存的安装包列表 */
  list: (): Promise<ClientReleaseDto[]> => api.get(`${API_PATHS.update}/client/releases`),
  /**
   * 让服务端从 GitHub 下载指定版本并登记。
   *
   * ⚠️ **必须显式放宽超时**：axios 实例默认 20 秒，而服务端自己允许下载 10 分钟
   * （`client-releases.service.ts` 的 `FETCH_TIMEOUT_MS`）。用默认值会在服务端还在下载时
   * 就报"请求超时"，用户会以为失败而重复点。这里与服务端取同一个上限。
   */
  fetch: (version: string): Promise<ClientReleaseDto> =>
    api.post(
      `${API_PATHS.update}/client/fetch`,
      { version },
      { timeout: CLIENT_RELEASE_FETCH_TIMEOUT_MS },
    ),
  /** 登记一份已经手工放进 `data/client-releases/<版本>/` 的安装包 */
  register: (payload: { version: string; fileName?: string; notes?: string }): Promise<ClientReleaseDto> =>
    api.post(`${API_PATHS.update}/client/releases`, payload),
  /** 删除缓存（元数据 + 磁盘文件） */
  remove: (version: string): Promise<{ version: string }> =>
    api.delete(`${API_PATHS.update}/client/releases/${encodeURIComponent(version)}`),
};

/* ------------------------------------------------------------------ 大模型助手 */

/**
 * 大模型助手的接口前缀（取自共享契约 `API_PATHS.ai`，与服务端 `modules/ai` 的挂载点同源）。
 */
const AI_BASE = API_PATHS.ai;

/**
 * 大模型助手（服务端 `modules/ai`）。
 *
 * 权限：`settings` / `audit` 要 `ai:manage`（仅管理员）；`interpret` 要 `ai:use`（教师也有）。
 *
 * ⚠️ **助手只解析、不落库**：`interpret` 只是把一句中文换成结构化参数，
 * 真正写数据仍然由前端在老师确认后调既有的发布接口（作业 / 通知 / 叫人）。
 */
export const aiApi = {
  /**
   * 读取配置。
   *
   * 只有 `ai:manage` 能读（教师读会 403，而响应拦截器会弹一个错误提示），
   * 所以助手页**不要**无条件调它——教师侧靠"探测式"：直接尝试解析，
   * 服务端回了 `AI_NOT_CONFIGURED` 再切空态。
   */
  settings: (): Promise<AiSettingsDto> => api.get(`${AI_BASE}/settings`),
  /**
   * 保存配置。
   *
   * `apiKey` 的三种语义（服务端约定）：传字符串 = 换新、传 `null` = 清除、**不传 = 保持原样**。
   * 因此"留空表示不修改"时不要往 body 里塞 `apiKey: ''`，那会被当成一个空密钥。
   */
  updateSettings: (payload: UpdateAiSettingsRequest): Promise<AiSettingsDto> =>
    api.put(`${AI_BASE}/settings`, payload),
  /** 把一句话解析成待确认的操作；`text` 上限 500 字（超出由服务端 400） */
  interpret: (payload: { text: string; classId?: string }): Promise<AiInterpretResult> =>
    api.post(`${AI_BASE}/interpret`, payload),
  /** 使用记录（谁、什么时候、说了什么、解析成什么、结果如何），倒序 */
  audit: (limit = 50): Promise<AiAuditDto[]> => api.get(`${AI_BASE}/audit`, { limit }),
};

/* ------------------------------------------------------------------ 系统设置与诊断 */

/**
 * 系统设置与诊断（服务端 `modules/system`），全部要 `system:manage`（仅管理员）。
 */
const SYSTEM_BASE = API_PATHS.system;

export const systemApi = {
  settings: (): Promise<SystemSettingsDto> => api.get(`${SYSTEM_BASE}/settings`),
  /** 目前只有 `developerMode` 一项；保存后服务端返回完整设置 */
  updateSettings: (payload: Partial<SystemSettingsDto>): Promise<SystemSettingsDto> =>
    api.put(`${SYSTEM_BASE}/settings`, payload),
  /** 只读诊断信息（版本 / Node / 平台 / 运行时长 / 数据库 / 目录 / 模块数） */
  diagnostics: (): Promise<SystemDiagnosticsDto> => api.get(`${SYSTEM_BASE}/diagnostics`),
};
