import { z } from 'zod';
import {
  WEEK_PARITY_VALUES,
  CLASSISLAND_NOTIFICATION_MAX_DURATION,
  CLASSISLAND_NOTIFICATION_DEFAULT_DURATION,
} from '@classhelper/shared';
import { booleanFlagSchema, timeSchema } from '../../lib/schemas.js';

/** 1=周一 … 7=周日 */
const dayOfWeekSchema = z.coerce.number().int().min(1).max(7);

export const integrationModeSchema = z.enum(['plugin', 'import']);
export const weekParitySchema = z.enum(WEEK_PARITY_VALUES as unknown as [string, ...string[]]);

/* ------------------------------------------------------------------ Web 管理端 */

export const listDevicesQuerySchema = z.object({
  classId: z.string().min(1).optional(),
});

export const createDeviceSchema = z.object({
  classId: z.string().min(1, '请选择班级'),
  name: z.string().trim().max(40).optional(),
  mode: integrationModeSchema.optional(),
  /**
   * 是否允许插件把 ClassIsland 的课表**自动**回传到本服务。
   * 默认 **false**（课表以服务端为准）；要取教室的课表用「从教室机器获取课表」这个手动动作。
   */
  syncScheduleToServer: z.boolean().optional(),
  /** 是否允许把本班课表镜像回 ClassIsland。默认 **true** —— 这是现在课表同步的主方向。 */
  mirrorScheduleToClassIsland: z.boolean().optional(),
});

export const updateDeviceSchema = z.object({
  name: z.string().trim().max(40).optional(),
  enabled: z.boolean().optional(),
  mode: integrationModeSchema.optional(),
  syncScheduleToServer: z.boolean().optional(),
  mirrorScheduleToClassIsland: z.boolean().optional(),
});

export const deviceIdParamSchema = z.object({ id: z.string().min(1, '缺少设备 id') });

export const sendNotificationSchema = z.object({
  classId: z.string().min(1, '请选择班级'),
  title: z.string().trim().min(1, '请输入提醒标题').max(120),
  content: z.string().trim().min(1, '请输入提醒内容').max(2000),
  durationSeconds: z.coerce.number().int().min(1).max(CLASSISLAND_NOTIFICATION_MAX_DURATION).optional(),
  speech: booleanFlagSchema,
  speechContent: z.string().trim().max(500).optional(),
  saveToNotifications: z.boolean().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
});

/* ------------------------------------------------------------------ 插件侧（设备令牌鉴权） */

export const reportScheduleEntrySchema = z.object({
  dayOfWeek: dayOfWeekSchema,
  startTime: timeSchema,
  endTime: timeSchema,
  subject: z.string().trim().min(1, '科目不能为空').max(40),
  teacherName: z.string().trim().max(40).nullish(),
  weekParity: weekParitySchema.optional(),
  weekCountDiv: z.coerce.number().int().min(0).max(30).optional(),
  weekCountDivTotal: z.coerce.number().int().min(0).max(30).optional(),
  planName: z.string().trim().max(60).optional(),
});

export const reportTimeLayoutItemSchema = z.object({
  index: z.coerce.number().int().min(0).max(200).optional(),
  name: z.string().trim().max(40).optional(),
  startTime: timeSchema,
  endTime: timeSchema,
  type: z.enum(['class', 'break', 'divider', 'action']).optional(),
  skipped: z.boolean().optional(),
});

export const classIslandReportSchema = z.object({
  pluginVersion: z.string().trim().max(40).optional(),
  classIslandVersion: z.string().trim().max(40).optional(),
  /**
   * 插件生成的机器码。设备创建时服务端还不知道它是谁，只能用 `pending-…` 占位，
   * 因此插件每次上报都带上它，服务端据此回填，Web 端设备列表才能与教室机器对上
   * （见 integrations.service 的 syncDeviceKey）。
   */
  deviceKey: z.string().trim().max(64).optional(),
  state: z
    .object({
      inClass: z.boolean().optional(),
      subject: z.string().trim().max(40).nullish(),
      nextSubject: z.string().trim().max(40).nullish(),
      timeState: z.string().trim().max(40).nullish(),
      periodStart: timeSchema.nullish(),
      periodEnd: timeSchema.nullish(),
      week: z.coerce.number().int().min(1).max(60).nullish(),
      classPlanLoaded: z.boolean().optional(),
      clientTime: z.string().trim().max(40).optional(),
    })
    .optional(),
  schedule: z
    .object({
      mode: z.enum(['replace', 'merge']).optional(),
      entries: z.array(reportScheduleEntrySchema).max(500, '单次上报的课程条目过多'),
    })
    .nullish(),
  timeLayout: z
    .object({
      name: z.string().trim().max(60).optional(),
      mode: z.enum(['replace', 'merge']).optional(),
      items: z.array(reportTimeLayoutItemSchema).max(200, '单次上报的节次过多'),
    })
    .nullish(),
});

/** 插件确认某条提醒已弹出（避免重连后重复补发） */
export const ackNotificationSchema = z.object({
  id: z.string().min(1, '缺少提醒 id'),
});

/** 插件上报的默认值集中在这里，避免散落在 service 里 */
export const REPORT_DEFAULTS = {
  scheduleMode: 'merge',
  timeLayoutMode: 'merge',
  timeLayoutName: 'ClassIsland 时间表',
  notificationDuration: CLASSISLAND_NOTIFICATION_DEFAULT_DURATION,
} as const;

export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;
export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;
export type SendNotificationInput = z.infer<typeof sendNotificationSchema>;
export type ClassIslandReportInput = z.infer<typeof classIslandReportSchema>;
export type ReportScheduleEntry = z.infer<typeof reportScheduleEntrySchema>;
export type ReportTimeLayoutItem = z.infer<typeof reportTimeLayoutItemSchema>;
