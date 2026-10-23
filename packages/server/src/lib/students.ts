/** 所有在读入口共用；归档/转出专页显式读取历史状态。 */
export function activeStudentWhere() {
  return { status: 'active', archivedYearId: null };
}
export function isActiveStudent(student: { status: string; archivedYearId?: string | null }) {
  return student.status === 'active' && !student.archivedYearId;
}
