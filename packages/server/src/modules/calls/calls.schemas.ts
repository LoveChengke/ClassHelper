import { z } from 'zod';

/**
 * "叫人"请求：老师选一位学生 + 快捷短语/自定义消息，让学生在灵动岛上立即收到
 * "请 XXX 同学找 XXX 老师"。
 */
export const createCallSchema = z
  .object({
    /** 学生 id（与 studentName 二选一） */
    studentId: z.string().min(1).optional(),
    classId: z.string().min(1, '请选择班级'),
    /** 快捷短语（可选） */
    quickPhrase: z.string().trim().max(64).optional(),
    /** 自定义消息（可选；与 quickPhrase 至少填一个） */
    message: z.string().trim().max(200).optional(),
  })
  .refine((data) => Boolean(data.studentId), { message: '请选择学生', path: ['studentId'] })
  .refine((data) => Boolean(data.message || data.quickPhrase), {
    message: '请选择快捷短语或填写自定义消息',
    path: ['message'],
  });

export type CreateCallInput = z.infer<typeof createCallSchema>;
