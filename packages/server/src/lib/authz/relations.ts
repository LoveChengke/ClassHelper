import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../db.js';
import type { TokenPayload } from '../jwt.js';

export function classDeviceClassId(user: TokenPayload): string | null {
  return user.role === 'CLASS_DEVICE' && user.classSession ? (user.classId ?? user.sub) : null;
}
export async function isHead(
  user: TokenPayload,
  classId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  return !!(await db.class.count({ where: { id: classId, teacherId: user.sub } }));
}
export async function isTeaching(
  user: TokenPayload,
  classId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  return (
    (await isHead(user, classId, db)) ||
    !!(await db.course.count({ where: { classId, teacherId: user.sub } }))
  );
}
