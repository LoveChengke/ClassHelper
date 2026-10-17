/** 所有在读入口共用；归档/转出专页显式读取历史状态。 */
export function activeStudentWhere() {
  return { status: { notIn: ['transferred', 'inactive'] } };
}
export function isActiveStudent(student: { status: string }) {
  return !activeStudentWhere().status.notIn.includes(student.status);
}
