import type { ClassPeriod as ContractClassPeriod } from './types.js';
import type { ScheduleDto } from './types.js';

export const TIME_POINT_TYPES = ['LESSON', 'BREAK', 'DIVIDER', 'ACTION'] as const;
export type TimePointType = (typeof TIME_POINT_TYPES)[number];
export interface TimePointDto {
  id: string;
  position: number;
  name: string;
  startTime: string;
  endTime: string;
  timeType: TimePointType;
  isHideDefault: boolean;
  defaultClassId: string | null;
  breakName: string;
  actionSet: string;
}
export interface TimeLayoutDetailDto {
  id: string;
  name: string;
  classId: string | null;
  points: TimePointDto[];
}
export interface DailyPlanEntryDto {
  id: string;
  timeLayoutItemId: string;
  courseId: string | null;
  isEnabled: boolean;
  isChangedClass: boolean;
  location: string | null;
}
export interface ClassPlanDto {
  id: string;
  classId: string;
  name: string;
  timeLayoutId: string;
  associatedGroup: string | null;
  weekday: number;
  weekCountDiv: number;
  weekCountDivTotal: number;
  weekStart: number;
  weekEnd: number;
  isEnabled: boolean;
  isOverlay: boolean;
  overlaySourceId: string | null;
  entries: DailyPlanEntryDto[];
}
export interface ActiveClassPlanDto {
  classPlan: ClassPlanDto | null;
  timeLayout: TimeLayoutDetailDto | null;
  schedules: ScheduleDto[];
  current: ContractClassPeriod | null;
  next: ContractClassPeriod | null;
  inClass: boolean;
  week: number;
}
export interface ActiveClassPlanWeekDto {
  classId: string;
  week: number;
  days: Array<ActiveClassPlanDto & { weekday: number; date: string }>;
}

/** 设置来自服务端；离线/未初始化时统一回落 30。 */
export function getMaxTermWeeks(configured?: unknown): number {
  const value = Number(configured);
  return Number.isInteger(value) && value >= 1 && value <= 60 ? value : 30;
}

export type PermissionScope = 'SELF_CLASS' | 'GRADE' | 'DIVISION' | 'ALL';
export interface ReleaseProgressDto {
  version: string;
  stage: 'idle' | 'downloading' | 'verifying' | 'ready' | 'waiting' | 'installing' | 'failed';
  downloadedBytes: number;
  totalBytes: number;
  percent: number | null;
  error: string;
}
/** 设备上报状态与服务端缓存安装包的下载状态分开。 */
export interface ClientUpdateProgressDto extends Omit<ReleaseProgressDto, 'stage'> {
  stage: ReleaseProgressDto['stage'] | 'completed';
  updatedAt?: string;
}
export interface CollectiveGradeAnalysisDto {
  mode: 'collective';
  classId: string;
  suppressed: boolean;
  averagePercent: number | null;
  passRate: number | null;
  excellentRate: number | null;
  subjects: { name: string; averagePercent: number | null }[];
  distribution: { label: string; count: number | null }[];
  trend: { examName: string; averagePercent: number | null }[];
}
