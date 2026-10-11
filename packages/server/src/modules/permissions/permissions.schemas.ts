import { PERMISSION_KEYS, type PermissionKey } from '@classhelper/shared';
import { z } from 'zod';

/**
 * 权限键校验：必须是 shared 的 `PERMISSION_KEYS` 之一。
 *
 * 用 refine 而不是 `z.enum(PERMISSION_KEYS)`：后者需要一个非空元组类型，
 * 而 `PERMISSION_KEYS` 是 `as const` 推导出来的只读元组，转换写法又长又脆。
 *
 * 写入口一律拒绝未知键；**读出口静默忽略**（库里可能留着已下线的键）——
 * 见 `lib/permissions.ts` 的 known 集合。
 */
export const permissionKeySchema = z
  .string()
  .refine((value): value is PermissionKey => (PERMISSION_KEYS as readonly string[]).includes(value), {
    message: '未知的权限键',
  });

/** 一次最多 200 个键（目录现在不到 40 个，留余量同时挡住离谱的请求体） */
const keysSchema = z.array(permissionKeySchema).max(200, '一次最多提交 200 个权限键');

export const createPermissionGroupSchema = z.object({
  name: z.string().trim().min(1, '请输入权限组名称').max(40, '权限组名称最多 40 个字'),
  description: z.string().trim().max(200, '描述最多 200 个字').optional(),
  keys: keysSchema.optional(),
});

/**
 * 改权限组：字段都是可选的，**传了就整体替换**。
 *
 * `keys` 是"整体替换"而不是增删（前端权限页本来就是一次提交整棵勾选树），
 * 这样不会出现"看着没勾上、其实还生效"的幽灵权限。
 */
export const updatePermissionGroupSchema = z.object({
  name: z.string().trim().min(1, '请输入权限组名称').max(40, '权限组名称最多 40 个字').optional(),
  description: z.string().trim().max(200, '描述最多 200 个字').optional(),
  keys: keysSchema.optional(),
});

/** 给账号分配权限组：整体替换；传空数组 = 回到角色默认模板 */
export const assignUserGroupsSchema = z.object({
  groupIds: z.array(z.string().min(1)).max(50, '一次最多分配 50 个权限组'),
});

export type CreatePermissionGroupInput = z.infer<typeof createPermissionGroupSchema>;
export type UpdatePermissionGroupInput = z.infer<typeof updatePermissionGroupSchema>;
export type AssignUserGroupsInput = z.infer<typeof assignUserGroupsSchema>;
