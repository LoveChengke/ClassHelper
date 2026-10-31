import type { PermissionScope } from './class-plan.js';

/** 范围解析供保存、查询与展示共用；旧库空岗位范围会由调用方拒绝访问。 */
export function parsePermissionScope(scope: PermissionScope, value = '', knownGrades?: readonly string[]) {
  if (scope === 'ALL' || scope === 'TEACHING' || scope === 'HEAD') {
    if (value !== '') throw new Error('关联班级或全校范围不接受范围值');
    return {
      scope,
      scopeValue: '',
      grades: [],
      scopeLabel: scope === 'ALL' ? '全校' : scope === 'HEAD' ? '仅班主任班' : '班主任与任课班级',
    };
  }
  if (scope !== 'GRADE' && scope !== 'DIVISION') throw new Error('未知的数据范围');
  const grades = [...new Set(value.split(/[,，、\s]+/u).filter(Boolean))].sort();
  if (!grades.length) throw new Error('请选择范围中的年级');
  if (scope === 'GRADE' && grades.length !== 1) throw new Error('年级范围只能选择一个年级');
  if (knownGrades && grades.some((grade) => !knownGrades.includes(grade)))
    throw new Error('范围包含未知年级，请刷新选项');
  return {
    scope,
    scopeValue: grades.join(','),
    grades,
    scopeLabel: `${scope === 'GRADE' ? '年级' : '部'}：${grades.join('、')}`,
  };
}

export interface PromotionPlan {
  tracks: {
    id: string;
    name: string;
    entryClassCount: number;
    stages: { grade: string; terminal?: boolean }[];
  }[];
  termStartDate: string | null;
  resetTermWeeks: boolean;
}
export function defaultPromotionPlan(classCount = 1): PromotionPlan {
  return {
    tracks: [
      {
        id: 'high',
        name: '高中',
        entryClassCount: classCount,
        stages: [{ grade: '高一' }, { grade: '高二' }, { grade: '高三', terminal: true }],
      },
    ],
    termStartDate: null,
    resetTermWeeks: true,
  };
}

/** 仅迁移和旧快照恢复使用；运行时不接受旧枚举。 */
export function migratePermissionScope(scope: string, scopeValue = '') {
  return scope === 'SELF_CLASS'
    ? { scope: scopeValue === 'HEAD' ? 'HEAD' : 'TEACHING', scopeValue: '' }
    : { scope, scopeValue };
}
