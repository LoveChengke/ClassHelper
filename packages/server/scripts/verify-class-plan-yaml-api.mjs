import { readFileSync } from 'node:fs';

/** 由隔离 E2E 启动器调用，在独立临时班级验收 YAML 写入及权限。 */
export async function verifyClassPlanYamlApi({
  api,
  record,
  adminToken,
  teacherToken,
  teacher2Token,
  teacher1Id,
}) {
  const created = await api('/classes', {
    method: 'POST',
    token: adminToken,
    body: { grade: '高一', enrollmentYear: 2026, classIndex: 98, teacherId: teacher1Id },
  });
  const classId = created.payload?.data?.id;
  record('YAML 验收使用独立临时班级', created.status === 201 && Boolean(classId));
  if (!classId) return;
  const text = readFileSync(new URL('../../../yml导入格式示例.yml', import.meta.url), 'utf8');
  const call = (suffix, source = text, mode = 'merge', token = teacherToken) =>
    api(`/imports/class-plan/yaml${suffix}`, {
      method: 'POST',
      token,
      body: { classId, text: source, mode },
    });
  try {
    const preview = await call('/preview');
    const before = await api(`/class-plans?classId=${classId}`, { token: teacherToken });
    record(
      'YAML 示例预览：6 节、3 张课表、只读不写库',
      preview.status === 200 &&
        preview.payload?.data?.entries.length === 6 &&
        preview.payload?.data?.planCount === 3 &&
        preview.payload?.data?.errors.length === 0 &&
        before.payload?.data?.length === 0,
    );
    const first = await call('');
    const list = await api(`/class-plans?classId=${classId}`, { token: teacherToken });
    const plans = list.payload?.data ?? [];
    const ids = plans.map((plan) => plan.id).sort();
    record(
      'YAML 示例落库并保留单双周',
      first.status === 200 &&
        plans.length === 3 &&
        plans.some((plan) => plan.weekCountDiv === 1 && plan.weekCountDivTotal === 2) &&
        plans.some((plan) => plan.weekCountDiv === 2 && plan.weekCountDivTotal === 2),
    );
    const entries = plans.flatMap((plan) => plan.entries ?? []);
    record(
      'YAML 教室写入课次地点',
      entries.length === 6 && entries.every((entry) => ['101', '102', '103', '104'].includes(entry.location)),
    );
    const courses = await api(`/courses?classId=${classId}`, { token: teacherToken });
    record(
      'YAML 简称落库且教师字段不改变任课授权',
      courses.payload?.data?.length === 4 &&
        courses.payload.data.every((course) => course.teacherId === teacher1Id && course.initial),
    );
    const again = await call('');
    const merged = await api(`/class-plans?classId=${classId}`, { token: teacherToken });
    record(
      'YAML 重复合并更新原对象，不产生重复课表',
      again.status === 200 &&
        JSON.stringify(merged.payload?.data?.map((plan) => plan.id).sort()) === JSON.stringify(ids),
    );
    const rejected = await call('', 'version: 1\nschedules: broken', 'replace');
    const after = await api(`/class-plans?classId=${classId}`, { token: teacherToken });
    record(
      'YAML 非法覆盖返回 400 且原课表保留',
      rejected.status === 400 &&
        JSON.stringify(after.payload?.data?.map((plan) => plan.id).sort()) === JSON.stringify(ids),
    );
    const denied = await call('', text, 'replace', teacher2Token);
    record('YAML 导入拒绝跨班教师', denied.status === 403);
    const tooLarge = await call('/preview', '#中文'.repeat(1_200_000));
    record('YAML 按 UTF-8 字节限制 8 MB，超限返回 413', tooLarge.status === 413);
    const replacement = await call('', text, 'replace');
    const replaced = await api(`/class-plans?classId=${classId}`, { token: teacherToken });
    record(
      'YAML 覆盖导入成功且保留三张课表',
      replacement.status === 200 && replaced.payload?.data?.length === 3,
    );
  } finally {
    const removed = await api(`/classes/${classId}`, { method: 'DELETE', token: adminToken });
    record('YAML 临时班级验收数据清理', removed.status === 200);
  }
}
