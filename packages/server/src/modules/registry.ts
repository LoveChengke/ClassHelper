import { archivesModule } from './archives/archives.module.js';
import { authModule } from './auth/auth.module.js';
import { callsModule } from './calls/calls.module.js';
import { classesModule } from './classes/classes.module.js';
import { coursesModule } from './courses/courses.module.js';
import { databaseModule } from './database/database.module.js';
import { dashboardModule } from './dashboard/dashboard.module.js';
import { gradesModule } from './grades/grades.module.js';
import { homeworksModule } from './homeworks/homeworks.module.js';
import { importsModule } from './imports/imports.module.js';
import { integrationsModule } from './integrations/integrations.module.js';
import { notificationsModule } from './notifications/notifications.module.js';
import { schedulesModule } from './schedules/schedules.module.js';
import { studentsModule } from './students/students.module.js';
import { teachersModule } from './teachers/teachers.module.js';
import { termModule } from './term/term.module.js';
import { updateModule } from './update/update.module.js';
import type { ApiModule } from './module.types.js';

/**
 * 模块注册表 —— 模块化设计的唯一入口。
 *
 * 新增功能：新建 modules/<name>/ 目录并在这里加一行；
 * 移除功能：删除对应一行（router 不再挂载，相关接口立即消失）；
 * 临时下线：把 enabled 置为 false。
 */
export const apiModules: ApiModule[] = [
  authModule,
  classesModule,
  coursesModule,
  schedulesModule,
  homeworksModule,
  notificationsModule,
  callsModule,
  importsModule,
  integrationsModule,
  gradesModule,
  studentsModule,
  teachersModule,
  archivesModule,
  termModule,
  dashboardModule,
  databaseModule,
  updateModule,
].filter((module) => module.enabled !== false);
