import { z } from 'zod';

/**
 * 安装包文件名/版本号只允许这些字符。
 *
 * 它们会被拼进磁盘路径（`data/client-releases/<版本>/<文件名>`），
 * 所以必须挡住 `..`、`/`、`\` —— 否则一个 `version=../../` 就能写到仓库外面去。
 */
const SAFE_SEGMENT = /^[0-9A-Za-z._-]+$/;

export const clientReleaseVersionSchema = z
  .string()
  .trim()
  .min(1, '请输入版本号')
  .max(40, '版本号最多 40 个字符')
  .refine((value) => SAFE_SEGMENT.test(value) && value !== '.' && value !== '..' && !value.includes('..'), {
    message: '版本号只能包含字母、数字、点、下划线与短横线',
  });

/** `POST /api/update/client/fetch`：让服务端替教室机器从 GitHub 拉一份安装包 */
export const fetchClientReleaseSchema = z.object({
  version: clientReleaseVersionSchema,
});

/** `POST /api/update/client/releases`：登记一份已经放进磁盘的安装包（手工兜底与自动化用） */
export const registerClientReleaseSchema = z.object({
  version: clientReleaseVersionSchema,
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((value) => SAFE_SEGMENT.test(value) && value !== '.' && value !== '..' && !value.includes('..'), {
      message: '文件名只能包含字母、数字、点、下划线与短横线',
    })
    .optional(),
  notes: z.string().trim().max(500).optional(),
});

export const clientReleaseVersionParamSchema = z.object({ version: clientReleaseVersionSchema });

export type FetchClientReleaseInput = z.infer<typeof fetchClientReleaseSchema>;
export type RegisterClientReleaseInput = z.infer<typeof registerClientReleaseSchema>;
