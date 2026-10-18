/** 只定义分组；子页标题、图标和权限直接读取路由，避免菜单与路由各维护一套权限。 */
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
    paths: ['/classes', '/students', '/teachers', '/roster', '/term-weeks', '/archives'],
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
