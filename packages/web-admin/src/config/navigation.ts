import type { PermissionKey } from '@classhelper/shared';

/** 字符串动作使用服务端业务范围；manage 用于班级管理，permission 用于无班级目标的操作。 */
export type MenuAction = PermissionKey | { key: PermissionKey; scope: 'manage' | 'permission' };

/** 只定义分组；标题、图标、读权限和可操作条件均读取路由。 */
export const MANAGEMENT_GROUPS = [
  { id: 'workspace', title: '工作台', icon: 'Odometer', paths: ['/dashboard', '/assistant'] },
  {
    id: 'teaching',
    title: '教学事务',
    icon: 'Notebook',
    paths: ['/plan-editor', '/homeworks', '/notifications', '/courseware', '/grades'],
  },
  {
    id: 'school',
    title: '班级与人员',
    icon: 'School',
    paths: ['/classes', '/students', '/teachers', '/term-weeks', '/promotion', '/archives'],
  },
  { id: 'devices', title: '设备运维', icon: 'Monitor', paths: ['/clients'] },
  {
    id: 'system',
    title: '系统管理',
    icon: 'Setting',
    paths: ['/permissions', '/system-settings', '/ai-settings', '/database'],
  },
] as const;
export interface ManagementMenuItem {
  path: string;
  title: string;
  icon: string;
}
export interface ManagementMenuGroup {
  id: string;
  title: string;
  icon: string;
  items: ManagementMenuItem[];
}
