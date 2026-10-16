import { CLIENT_COMMAND_KINDS, CLIENT_COMMAND_RESULT_MAX, type ClientCommandKind } from '@classhelper/shared';
import { z } from 'zod';

/**
 * 远控命令种类。用 `CLIENT_COMMAND_KINDS` 而不是再写一遍字面量数组：
 * 常量是 `readonly`，`z.enum` 要的是可变元组，所以这里显式转一次类型。
 */
const clientCommandKindSchema = z.enum(
  CLIENT_COMMAND_KINDS as unknown as [ClientCommandKind, ...ClientCommandKind[]],
);

/** 设备标识（客户端主进程生成并持久化的 UUID） */
const deviceKeySchema = z.string().trim().min(8, '设备标识不合法').max(80, '设备标识不合法');

/** `POST /api/clients/heartbeat`：客户端每 30 秒一次的上报 */
export const clientHeartbeatSchema = z.object({
  agentProtocol: z.number().int().min(1).max(2).optional(),
  deviceKey: deviceKeySchema,
  name: z.string().trim().max(60).optional(),
  clientVersion: z.string().trim().max(40).optional(),
  platform: z.string().trim().max(40).optional(),
  autoUpdate: z.boolean().optional(),
  pendingVersion: z.string().trim().max(40).nullable().optional(),
  stateNote: z.string().trim().max(120).optional(),
});

/**
 * `POST /api/clients/commands/:id/ack`：执行回执。
 *
 * 带上 `deviceKey` 是为了"命令回执必须是那台机器签的字"：一个班的班级端令牌
 * 全班共用，光凭命令 id 无法区分是班里哪一台。
 */
export const clientCommandAckSchema = z.object({
  deviceKey: deviceKeySchema,
  ok: z.boolean(),
  result: z.string().trim().max(CLIENT_COMMAND_RESULT_MAX).optional(),
});

/** `POST /api/clients/commands`：给选中的电脑下发远控命令 */
export const createClientCommandSchema = z.object({
  deviceIds: z.array(z.string().min(1)).min(1, '请选择要操作的电脑').max(200, '一次最多操作 200 台'),
  kind: clientCommandKindSchema,
  note: z.string().trim().max(80, '备注最多 80 个字').optional(),
});

/** `GET /api/clients/devices?classId=` */
export const listClientDevicesQuerySchema = z.object({
  classId: z.string().trim().min(1).optional(),
});

/** `POST /api/clients/updates`：推送更新（按设备 / 按班级 / 全部） */
export const pushClientUpdateSchema = z.object({
  deviceIds: z.array(z.string().min(1)).max(500).optional(),
  classIds: z.array(z.string().min(1)).max(200).optional(),
  all: z.boolean().optional(),
  version: z.string().trim().max(40).nullable().optional(),
  clear: z.boolean().optional(),
  mode: z.enum(['idle', 'immediate', 'after-school']).default('idle'),
  afterSchoolTime: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '放学时间应为 HH:mm')
    .optional(),
});

export type ClientHeartbeatInput = z.infer<typeof clientHeartbeatSchema>;
export type ClientCommandAckInput = z.infer<typeof clientCommandAckSchema>;
export type CreateClientCommandInput = z.infer<typeof createClientCommandSchema>;
export type ListClientDevicesQuery = z.infer<typeof listClientDevicesQuerySchema>;
export type PushClientUpdateInput = z.infer<typeof pushClientUpdateSchema>;
