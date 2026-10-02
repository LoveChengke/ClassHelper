import { z } from 'zod';

/** 本项目支持的主数据库类型。Redis 等键值库不是 Prisma 支持的主库，不提供切换。 */
export const databaseProviderSchema = z.enum(['sqlite', 'mysql']);
export type DatabaseProviderInput = z.infer<typeof databaseProviderSchema>;

/** 连接串与 provider 配套校验：SQLite 必须 file: 前缀，MySQL 必须 mysql:// 前缀 */
export const targetConnectionSchema = z
  .object({
    provider: databaseProviderSchema,
    url: z.string().min(1, '请填写连接串'),
  })
  .superRefine((value, ctx) => {
    const url = value.url.trim();
    if (value.provider === 'sqlite' && !url.startsWith('file:')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'SQLite 连接串必须以 file: 开头，例如 file:./data/classhelper.db',
      });
    }
    if (value.provider === 'mysql' && !/^mysqls?:\/\//.test(url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'MySQL 连接串必须以 mysql:// 或 mysqls:// 开头',
      });
    }
  });

export type TargetConnectionInput = z.infer<typeof targetConnectionSchema>;

/** POST /database/test-connection：测试任意目标库的连通性 */
export const testConnectionSchema = targetConnectionSchema;
export type TestConnectionInput = z.infer<typeof testConnectionSchema>;

/** POST /database/switch：一键切换数据库（含数据迁移） */
export const switchDatabaseSchema = targetConnectionSchema;
export type SwitchDatabaseInput = z.infer<typeof switchDatabaseSchema>;

/** POST /database/import：上传快照（base64，随 JSON 请求体，受 12MB 请求体限制） */
export const importSnapshotSchema = z.object({
  data: z.string().min(1, '请提供快照内容（base64）'),
});
export type ImportSnapshotInput = z.infer<typeof importSnapshotSchema>;

/** PUT /database/backup-schedule：定时备份配置 */
export const backupScheduleSchema = z.object({
  enabled: z.boolean(),
  /** 间隔小时数（1~720，默认 24 = 每天一次） */
  intervalHours: z.number().int().min(1).max(720),
  /** 最多保留多少份自动备份（超出后删最旧的；手动备份不受影响） */
  keepCount: z.number().int().min(1).max(100),
});
export type BackupScheduleInput = z.infer<typeof backupScheduleSchema>;

/** 路径参数：备份文件名（必须是本服务生成的固定格式，杜绝路径穿越） */
export const backupNameParamSchema = z.object({
  name: z.string().regex(/^backup-(manual|auto)-\d{8}-\d{6}\.json\.gz$/, '备份文件名不合法'),
});

/** 路径参数：切换任务 id（本服务生成，字母数字与连字符） */
export const jobIdParamSchema = z.object({
  id: z.string().regex(/^[0-9a-z-]{6,40}$/, '任务 id 不合法'),
});
