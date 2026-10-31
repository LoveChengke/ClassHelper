import type { UserRole } from '@classhelper/shared';
import { prisma } from '../db.js';
import { ApiError } from '../http.js';
import type { TokenPayload } from '../jwt.js';
export async function loadSessionUser(payload: TokenPayload): Promise<TokenPayload> {
  if (payload.classSession && payload.role === 'CLASS_DEVICE') {
    const cls = await prisma.class.findUnique({ where: { id: payload.classId ?? payload.sub } });
    if (!cls || cls.archivedYearId) throw ApiError.unauthorized('班级不存在或已归档');
    return {
      sub: cls.id,
      username: cls.code,
      name: cls.name,
      role: 'CLASS_DEVICE',
      classId: cls.id,
      classSession: true,
      classCode: cls.code,
    };
  }
  if (payload.role === 'CLASS_DEVICE') throw ApiError.unauthorized('无效班级会话');
  const row = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!row || !['ADMIN', 'TEACHER'].includes(row.role)) throw ApiError.unauthorized('账号不存在');
  return { sub: row.id, username: row.username, name: row.name, role: row.role as UserRole, classId: null };
}
