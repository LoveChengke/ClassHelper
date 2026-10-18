import { z } from 'zod';
import { COURSEWARE_MAX_BYTES } from '@classhelper/shared';

export const coursewareScopeSchema = z.object({ classIds: z.array(z.string().min(1).max(100)).max(100) });
export const coursewareUploadSchema = coursewareScopeSchema
  .extend({
    name: z
      .string()
      .trim()
      .min(1)
      .max(180)
      .refine(
        (name) => !/[<>:"/\\|?*\u0000-\u001f]/.test(name) && !name.endsWith('.') && !name.endsWith(' '),
        '文件名含无效字符',
      ),
    size: z.number().int().min(1).max(COURSEWARE_MAX_BYTES),
    mode: z.enum(['cloud', 'push']),
  })
  .refine((input) => input.mode !== 'push' || input.classIds.length > 0, '推送时请选择授课班级');
export const coursewareUploadQuery = z.object({
  metadata: z
    .string()
    .transform((value, ctx): unknown => {
      try {
        return JSON.parse(value);
      } catch {
        ctx.addIssue({ code: 'custom', message: '上传信息格式错误' });
        return z.NEVER;
      }
    })
    .pipe(coursewareUploadSchema),
});
export const coursewareDeviceQuery = z.object({ deviceKey: z.string().min(1).max(100) });
