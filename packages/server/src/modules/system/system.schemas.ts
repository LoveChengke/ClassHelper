import { z } from 'zod';

/** `PUT /api/system/settings`：目前只有开发者模式（字段都可选，传了就改） */
export const updateSystemSettingsSchema = z.object({
  developerMode: z.boolean().optional(),
});

/** `PUT /api/system/autostart`：开/关服务端开机自启 */
export const updateAutostartSchema = z.object({
  enabled: z.boolean(),
});

export type UpdateSystemSettingsInput = z.infer<typeof updateSystemSettingsSchema>;
export type UpdateAutostartInput = z.infer<typeof updateAutostartSchema>;
