import 'vue-router';
import type { PermissionKey } from '@classhelper/shared';
import type { MenuAction } from '@/config/navigation';

declare module 'vue-router' {
  interface RouteMeta {
    permission?: PermissionKey;
    /** 维护页面任一动作在至少一个可读班级生效时显示；纯查看页面省略此项。 */
    menuActions?: readonly MenuAction[];
  }
}
