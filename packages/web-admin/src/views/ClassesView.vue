<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  SOCKET_EVENTS,
  MAX_TERM_WEEK,
  SUBJECT_CATALOG,
  currentAcademicYearStart,
  formatClassName,
  STUDENT_STATUS_LABELS,
  formatDate,
  type ClassDetailDto,
  type ClassDto,
  type CourseDto,
  type StudentDto,
  type StudentStatus,
  type SubjectTeacherDto,
  type UpdateClassAccountRequest,
  type UserDto,
} from '@classhelper/shared';
import { classApi, courseApi, teacherApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useRealtimeStore } from '@/stores/realtime';
import { useResponsive } from '@/composables/useResponsive';

const auth = useAuthStore();
const realtime = useRealtimeStore();
const { isMobile } = useResponsive();

/** 仅管理员可管理班级（增删改）与人员分配 —— 与后端权限矩阵一致 */
const isAdmin = computed(() => auth.role === 'ADMIN');

/** 小屏下详情描述改为单列，避免文字被压成竖排 */
const detailColumns = computed(() => (isMobile.value ? 1 : 3));

const loading = ref(false);
const classes = ref<ClassDto[]>([]);
const keyword = ref('');

async function loadClasses(): Promise<void> {
  loading.value = true;
  try {
    classes.value = await classApi.list(keyword.value ? { keyword: keyword.value } : undefined);
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------ 新建 / 编辑班级 */

const formVisible = ref(false);
const formRef = ref<FormInstance>();
const editingId = ref<string | null>(null);
/**
 * 班级称呼是「XXXX级X班」（入学年份 + 班号），不是「高一(1)班」：
 * 后者每年都要改一遍，前者一路跟着这届学生到毕业（升级只改年级、称呼不变）。
 */
const form = reactive({
  grade: '',
  enrollmentYear: currentAcademicYearStart(),
  classIndex: 1,
  code: '',
  termWeeks: 20,
  headTeacherId: '',
});
const rules: FormRules = {
  grade: [{ required: true, message: '请输入年级', trigger: 'blur' }],
  enrollmentYear: [{ required: true, message: '请输入入学年份', trigger: 'blur' }],
  classIndex: [{ required: true, message: '请输入班号', trigger: 'blur' }],
};
/** 表单里实时预览班级称呼 */
const previewName = computed(() => formatClassName(form.enrollmentYear, form.classIndex));

/** 管理员可选班主任（教师 + 管理员账号）；「新建班级」才设置，「编辑」走单独的"更换班主任" */
const staffOptions = ref<UserDto[]>([]);

async function loadStaffOptions(): Promise<void> {
  if (!isAdmin.value) return;
  if (staffOptions.value.length > 0) return;
  staffOptions.value = await teacherApi.list().catch(() => []);
}

function openCreate(): void {
  editingId.value = null;
  form.grade = '';
  form.enrollmentYear = currentAcademicYearStart();
  form.classIndex = classes.value.length + 1;
  form.code = '';
  form.termWeeks = 20;
  form.headTeacherId = auth.user?.id ?? '';
  void loadStaffOptions();
  formVisible.value = true;
}

function openEdit(row: ClassDto): void {
  editingId.value = row.id;
  form.grade = row.grade;
  // 老数据可能没有届别：回填当前学年起始年份，管理员可在表单里改正
  form.enrollmentYear = row.enrollmentYear ?? currentAcademicYearStart();
  form.classIndex = row.classIndex ?? 1;
  form.code = '';
  form.termWeeks = row.termWeeks ?? 20;
  // 必须回填当前班主任：编辑弹窗里的下拉与"新建"共用同一个 form.headTeacherId，
  // 而 submitForm 会在"值不同"时直接调 assignHeadTeacher。不回填的话，只要之前打开过一次
  // 「新建班级」（openCreate 会把它设成当前管理员自己），之后保存任何一次编辑都会把
  // 该班班主任静默改成管理员本人 —— 而班主任决定谁能管这个班的课表与成绩。
  form.headTeacherId = row.teacher?.id ?? '';
  void loadStaffOptions();
  formVisible.value = true;
}

async function submitForm(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  if (editingId.value) {
    await classApi.update(editingId.value, {
      grade: form.grade,
      enrollmentYear: form.enrollmentYear,
      classIndex: form.classIndex,
      termWeeks: form.termWeeks,
    });
    // 编辑弹窗里也能直接换班主任（仅管理员；班主任决定谁能管这个班的课表与成绩）
    if (isAdmin.value && form.headTeacherId) {
      const target = classes.value.find((item) => item.id === editingId.value);
      if (target && target.teacher?.id !== form.headTeacherId) {
        await classApi.assignHeadTeacher(editingId.value, form.headTeacherId);
      }
    }
    ElMessage.success('班级已更新');
  } else {
    await classApi.create({
      grade: form.grade,
      enrollmentYear: form.enrollmentYear,
      classIndex: form.classIndex,
      // 学期周数：新建时也要提交。原先只提交名称/年级/班级码，表单里填的周数被直接丢弃，
      // 服务端落库恒为默认 20，用户看到的是"设置了没生效"且没有任何提示。
      termWeeks: form.termWeeks,
      ...(form.code.trim() ? { code: form.code.trim().toUpperCase() } : {}),
      ...(isAdmin.value && form.headTeacherId ? { teacherId: form.headTeacherId } : {}),
    });
    ElMessage.success(`班级 ${previewName.value} 创建成功`);
  }
  formVisible.value = false;
  await loadClasses();
}

/* ------------------------------------------------------------ 更换班主任（仅管理员） */

const headTeacherSaving = ref(false);

/** 详情页更换班主任：写 PATCH /api/classes/:id/head-teacher */
async function changeHeadTeacher(classId: string, teacherId: string): Promise<void> {
  if (!teacherId) return;
  headTeacherSaving.value = true;
  try {
    await classApi.assignHeadTeacher(classId, teacherId);
    ElMessage.success('班主任已更换');
    await Promise.all([loadClasses(), refreshDetail()]);
  } finally {
    headTeacherSaving.value = false;
  }
}

/* ------------------------------------------------------------ 班级账号（班级码 + 班级密码） */

const accountVisible = ref(false);
const accountSaving = ref(false);
const accountTarget = ref<ClassDto | null>(null);
const accountForm = reactive({ code: '', password: '' });

/** 打开班级账号设置：班级码即 ClassHelper 班级端「班级登录」的账号 */
function openAccount(row: ClassDto): void {
  accountTarget.value = row;
  accountForm.code = row.code ?? '';
  accountForm.password = '';
  accountVisible.value = true;
}

/** 一键生成一个易读的班级码（避开 0/O/1/I 等易混字符） */
function suggestCode(): void {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let body = '';
  for (let index = 0; index < 6; index += 1) {
    body += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  accountForm.code = body;
}

async function submitAccount(): Promise<void> {
  const target = accountTarget.value;
  if (!target) return;
  if (!accountForm.code.trim() && !accountForm.password) {
    ElMessage.warning('请填写新的班级码或班级密码');
    return;
  }

  accountSaving.value = true;
  try {
    const payload: UpdateClassAccountRequest = {};
    if (accountForm.code.trim() && accountForm.code.trim() !== target.code) {
      payload.code = accountForm.code.trim().toUpperCase();
    }
    if (accountForm.password) payload.password = accountForm.password;

    const updated = await classApi.updateAccount(target.id, payload);
    ElMessage.success(
      `班级账号已更新：班级码 ${updated.code ?? '-'}${accountForm.password ? '，班级密码已重置' : ''}`,
    );
    accountVisible.value = false;
    await loadClasses();
  } finally {
    accountSaving.value = false;
  }
}

async function removeClass(row: ClassDto): Promise<void> {
  await ElMessageBox.confirm(
    `删除「${row.name}」将同时删除其课表、作业、通知与成绩，确认继续？`,
    '危险操作',
    { type: 'warning', confirmButtonText: '确认删除' },
  );
  await classApi.remove(row.id);
  ElMessage.success('班级已删除');
  await loadClasses();
}

/* ------------------------------------------------------------ 班级详情抽屉 */

const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<ClassDetailDto | null>(null);
const activeTab = ref('students');

async function openDetail(row: ClassDto): Promise<void> {
  detailVisible.value = true;
  detailLoading.value = true;
  activeTab.value = 'students';
  try {
    detail.value = await classApi.detail(row.id);
  } finally {
    detailLoading.value = false;
  }
}

async function refreshDetail(): Promise<void> {
  if (!detail.value) return;
  detailLoading.value = true;
  try {
    detail.value = await classApi.detail(detail.value.id);
  } finally {
    detailLoading.value = false;
  }
}

/* ------------------------------------------------------------ 学生 */

const studentFormVisible = ref(false);
/** 学生只有名单：学号 + 姓名（没有密码、没有账号） */
const studentForm = reactive({
  studentNo: '',
  name: '',
  gender: '' as '' | 'MALE' | 'FEMALE',
  guardianPhone: '',
});
const studentRules: FormRules = {
  studentNo: [{ required: true, message: '请输入学号', trigger: 'blur' }],
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
};

async function addStudent(): Promise<void> {
  if (!detail.value) return;
  if (!studentForm.studentNo.trim() || !studentForm.name.trim()) {
    ElMessage.warning('请填写学号和姓名');
    return;
  }
  const created = await classApi.addStudent(detail.value.id, {
    studentNo: studentForm.studentNo.trim(),
    name: studentForm.name.trim(),
    ...(studentForm.gender ? { gender: studentForm.gender } : {}),
    ...(studentForm.guardianPhone.trim() ? { guardianPhone: studentForm.guardianPhone.trim() } : {}),
  });
  ElMessage.success(`已加入学生：${created.name}（${created.studentNo}）`);
  studentFormVisible.value = false;
  studentForm.studentNo = '';
  studentForm.name = '';
  studentForm.gender = '';
  studentForm.guardianPhone = '';
  await refreshDetail();
  await loadClasses();
}

async function removeStudent(row: StudentDto): Promise<void> {
  if (!detail.value) return;
  await ElMessageBox.confirm(`将「${row.name}」移出本班级？`, '确认', { type: 'warning' });
  await classApi.removeStudent(detail.value.id, row.id);
  ElMessage.success('已移出班级');
  await refreshDetail();
  await loadClasses();
}

/* ------------------------------------------------------------ 课程 */

const courseForm = reactive({ name: '' });

async function addCourse(): Promise<void> {
  if (!detail.value || !courseForm.name.trim()) {
    ElMessage.warning('请输入课程名称');
    return;
  }
  await courseApi.create({ name: courseForm.name.trim(), classId: detail.value.id });
  ElMessage.success('课程已添加');
  courseForm.name = '';
  await refreshDetail();
}

async function removeCourse(row: CourseDto): Promise<void> {
  await ElMessageBox.confirm(`删除课程「${row.name}」？相关课表与作业关联会被清除。`, '确认', {
    type: 'warning',
  });
  await courseApi.remove(row.id);
  ElMessage.success('课程已删除');
  await refreshDetail();
}

/* ------------------------------------------------------------ 任课老师（班级 + 科目 + 教师） */

/**
 * **这是「科任老师」这条关系的唯一写入口**。
 *
 * 作业与成绩能不能被某位老师改动，查的就是这里写下的 `Course.teacherId`：
 * 科任老师只能动自己任教的科目；班主任若不教这一科，同样改不了这一科。
 * 同一位老师可以既是班主任又是某科科任 —— 两条记录指向同一个账号，
 * 不重复建号，权限在服务端合并。
 */
const teachers = ref<UserDto[]>([]);
const subjectDraft = reactive({ subjectName: '', teacherId: '' });

async function loadTeachers(): Promise<void> {
  teachers.value = await teacherApi.list();
}

/** 该班还没有的科目（下拉里列出来，选中即自动建课） */
const assignableSubjects = computed(() => {
  const existing = new Set((detail.value?.subjectTeachers ?? []).map((item) => item.subjectName));
  return SUBJECT_CATALOG.filter((name) => !existing.has(name));
});

const subjectSaving = ref(false);

async function saveSubjectTeacher(): Promise<void> {
  if (!detail.value || !subjectDraft.subjectName.trim() || !subjectDraft.teacherId) {
    ElMessage.warning('请选择科目与任课老师');
    return;
  }
  subjectSaving.value = true;
  try {
    await classApi.assignSubjectTeachers(detail.value.id, [
      { subjectName: subjectDraft.subjectName.trim(), teacherId: subjectDraft.teacherId },
    ]);
    ElMessage.success('任课老师已设置');
    subjectDraft.subjectName = '';
    subjectDraft.teacherId = '';
    await refreshDetail();
  } finally {
    subjectSaving.value = false;
  }
}

/** 改某一科的任课老师（就地改，不新建科目） */
async function changeSubjectTeacher(row: SubjectTeacherDto, teacherId: string): Promise<void> {
  if (!detail.value || !teacherId) return;
  await classApi.assignSubjectTeachers(detail.value.id, [
    { courseId: row.courseId, subjectName: row.subjectName, teacherId },
  ]);
  ElMessage.success(`「${row.subjectName}」的任课老师已更新`);
  await refreshDetail();
}

/** 解除某科的任课老师（课程保留，作业与成绩仍挂在它上面） */
async function clearSubjectTeacher(row: SubjectTeacherDto): Promise<void> {
  if (!detail.value) return;
  await classApi.assignSubjectTeachers(detail.value.id, [
    { courseId: row.courseId, subjectName: row.subjectName, teacherId: null },
  ]);
  ElMessage.success(`已解除「${row.subjectName}」的任课老师`);
  await refreshDetail();
}

/* ------------------------------------------------------------ 班级设置：成绩查询开关 / 学年升级 */

const gradeQuerySaving = ref(false);

/** 是否允许教室的 ClassHelper 班级端按学号查询本班学生的成绩明细 */
async function toggleGradeQuery(enabled: boolean): Promise<void> {
  if (!detail.value) return;
  gradeQuerySaving.value = true;
  try {
    await classApi.setGradeQuery(detail.value.id, enabled);
    detail.value.studentGradeQueryEnabled = enabled;
    ElMessage.success(enabled ? '已允许班级端按学号查成绩' : '已关闭班级端成绩查询');
  } finally {
    gradeQuerySaving.value = false;
  }
}

const promoteForm = reactive({ grade: '', saving: false });

/** 学年升级：只改年级，**不归档**，班级记录/学生名单/学号/作业成绩全部沿用 */
async function promote(): Promise<void> {
  if (!detail.value || !promoteForm.grade.trim()) {
    ElMessage.warning('请填写升级后的年级，例如「高二」');
    return;
  }
  const target = promoteForm.grade.trim();
  await ElMessageBox.confirm(
    `把「${detail.value.name}」的年级改为「${target}」？升级只改年级，不归档：` +
      '班级记录、学生名单、学号、作业与成绩全部沿用。',
    '学年升级',
    { type: 'info', confirmButtonText: '确认升级' },
  );
  promoteForm.saving = true;
  try {
    await classApi.promote([detail.value.id], target);
    ElMessage.success('已升级，数据继续沿用');
    promoteForm.grade = '';
    await refreshDetail();
    await loadClasses();
  } finally {
    promoteForm.saving = false;
  }
}

/* ------------------------------------------------------------ 实时刷新 */

function onClassChanged(): void {
  void loadClasses();
  if (detailVisible.value) void refreshDetail();
}

onMounted(async () => {
  await Promise.all([loadClasses(), loadTeachers()]);
  realtime.on(SOCKET_EVENTS.classUpdated, onClassChanged);
  realtime.on(SOCKET_EVENTS.notificationNew, onClassChanged);
  realtime.on(SOCKET_EVENTS.homeworkNew, onClassChanged);
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.classUpdated, onClassChanged);
  realtime.off(SOCKET_EVENTS.notificationNew, onClassChanged);
  realtime.off(SOCKET_EVENTS.homeworkNew, onClassChanged);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">班级管理</h2>
        <p class="page-subtitle">教师只能看到并管理自己创建或被分配的班级</p>
      </div>
      <div class="toolbar">
        <el-input
          v-model="keyword"
          placeholder="搜索班级名称 / 年级"
          clearable
          style="width: 220px"
          @keyup.enter="loadClasses"
          @clear="loadClasses"
        />
        <el-button :icon="'Search'" @click="loadClasses">查询</el-button>
        <el-button v-if="isAdmin" type="primary" :icon="'Plus'" @click="openCreate">新建班级</el-button>
      </div>
    </div>

    <el-card shadow="never" class="table-card">
      <el-table v-loading="loading" :data="classes" empty-text="暂无班级，点击右上角新建">
        <el-table-column prop="name" label="班级" min-width="130" />
        <el-table-column label="届别" width="120">
          <template #default="{ row }">
            <el-tag v-if="row.enrollmentYear" size="small" effect="plain">
              {{ row.enrollmentYear }} 级 · {{ row.classIndex }} 班
            </el-tag>
            <span v-else class="text-muted">未设置</span>
          </template>
        </el-table-column>
        <el-table-column prop="grade" label="年级" width="90" />
        <el-table-column label="班主任" width="140">
          <template #default="{ row }">{{ row.teacher?.name ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="学生" width="80">
          <template #default="{ row }">{{ row.studentCount ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="课程" width="80">
          <template #default="{ row }">{{ row.courseCount ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="作业" width="80">
          <template #default="{ row }">{{ row.homeworkCount ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="通知" width="80">
          <template #default="{ row }">{{ row.notificationCount ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="班级账号（班级端登录）" width="200">
          <template #default="{ row }">
            <template v-if="row.code">
              <el-tag type="info" effect="plain">{{ row.code }}</el-tag>
              <el-tag :type="row.hasPassword ? 'success' : 'warning'" size="small" class="account-tag">
                {{ row.hasPassword ? '已设密码' : '未设密码' }}
              </el-tag>
            </template>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ formatDate(row.createdAt, true) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="310" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button v-if="isAdmin" link type="warning" @click="openAccount(row)">班级账号</el-button>
            <el-button v-if="isAdmin" link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button v-if="isAdmin" link type="danger" @click="removeClass(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 班级账号：班级码 + 班级密码（教室机器上 ClassHelper 班级端的登录凭据） -->
    <el-dialog v-model="accountVisible" title="班级账号（ClassHelper 班级端登录）" width="480px">
      <el-alert type="info" :closable="false" show-icon class="mb-12">
        <template #title>
          教室机器以「班级」为主体登录：班级码 + 班级密码。登录后本机代表整个班级，
          作业完成、通知已读都会按全班记录。<b>学生没有个人账号，不能登录</b>。
        </template>
      </el-alert>
      <el-form label-width="90px">
        <el-form-item label="班级">
          <el-input :model-value="accountTarget?.name ?? ''" disabled />
        </el-form-item>
        <el-form-item label="班级码">
          <el-input v-model="accountForm.code" placeholder="4~16 位字母或数字" style="width: 220px" />
          <el-button link type="primary" class="ml-8" @click="suggestCode">随机生成</el-button>
        </el-form-item>
        <el-form-item label="新密码">
          <el-input
            v-model="accountForm.password"
            type="password"
            show-password
            placeholder="留空表示不修改（至少 6 位）"
            style="width: 220px"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="accountVisible = false">取消</el-button>
        <el-button type="primary" :loading="accountSaving" @click="submitAccount">保存</el-button>
      </template>
    </el-dialog>

    <!-- 新建 / 编辑 -->
    <el-dialog v-model="formVisible" :title="editingId ? '编辑班级' : '新建班级'" width="460px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="入学年份" prop="enrollmentYear">
          <el-input-number v-model="form.enrollmentYear" :min="2000" :max="2100" :step="1" />
          <span class="text-muted ml-8">这一届学生入学的年份（届别）</span>
        </el-form-item>
        <el-form-item label="班号" prop="classIndex">
          <el-input-number v-model="form.classIndex" :min="1" :max="99" :step="1" />
        </el-form-item>
        <el-form-item label="班级称呼">
          <el-tag type="primary" effect="plain" size="large">{{ previewName }}</el-tag>
          <span class="text-muted ml-8">
            称呼由「入学年份 + 班号」生成；学年升级只改年级，称呼一路跟着这届学生到毕业
          </span>
        </el-form-item>
        <el-form-item label="年级" prop="grade">
          <el-input v-model="form.grade" placeholder="例如 高一" />
        </el-form-item>
        <el-form-item v-if="!editingId" label="班级码">
          <el-input v-model="form.code" placeholder="留空自动生成（4~16 位字母数字）" />
        </el-form-item>
        <el-form-item v-if="isAdmin" label="班主任">
          <el-select v-model="form.headTeacherId" placeholder="选择班主任" style="width: 100%" filterable>
            <el-option
              v-for="item in staffOptions"
              :key="item.id"
              :label="`${item.name}（${item.username}）`"
              :value="item.id"
            />
          </el-select>
          <span class="text-muted" style="width: 100%">
            班主任可以管理本班课表与成绩；留空则默认由创建者本人担任
          </span>
        </el-form-item>
        <el-form-item label="学期周数">
          <el-input-number v-model="form.termWeeks" :min="1" :max="MAX_TERM_WEEK" :step="1" />
          <span class="text-muted ml-8">
            本学期一共多少教学周（默认 20，最多 {{ MAX_TERM_WEEK }} 周）；课表周次选择与默认结束周都按它来
          </span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>

    <!-- 班级详情 -->
    <el-drawer v-model="detailVisible" size="60%" :title="detail ? `${detail.name} · 详情` : '班级详情'">
      <div v-loading="detailLoading">
        <el-descriptions v-if="detail" :column="detailColumns" border size="small">
          <el-descriptions-item label="届别">
            {{ detail.enrollmentYear ? `${detail.enrollmentYear} 级` : '未设置' }}
          </el-descriptions-item>
          <el-descriptions-item label="年级">{{ detail.grade }}</el-descriptions-item>
          <el-descriptions-item label="班主任">{{ detail.teacher?.name ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="学生数">{{ detail.students.length }}</el-descriptions-item>
          <el-descriptions-item label="班级端成绩查询">
            <el-tag :type="detail.studentGradeQueryEnabled ? 'success' : 'info'" size="small">
              {{ detail.studentGradeQueryEnabled ? '已开放' : '已关闭' }}
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>

        <!-- 更换班主任（仅管理员）：班主任决定谁能管这个班的课表与成绩 -->
        <div v-if="isAdmin && detail" class="toolbar mt-12">
          <span class="text-muted">更换班主任</span>
          <el-select
            :model-value="detail.teacher?.id ?? ''"
            placeholder="选择教师"
            style="width: 240px"
            filterable
            :loading="headTeacherSaving"
            @change="(value: string) => changeHeadTeacher(detail!.id, value)"
          >
            <el-option
              v-for="item in staffOptions"
              :key="item.id"
              :label="`${item.name}（${item.username}）`"
              :value="item.id"
            />
          </el-select>
          <span class="text-muted">切换班主任不影响任课关系：各科科任老师在下方「任课老师」里单独配</span>
        </div>

        <el-tabs v-model="activeTab" class="mt-12">
          <el-tab-pane label="学生名单" name="students">
            <div class="toolbar mt-12">
              <el-button type="primary" size="small" :icon="'Plus'" @click="studentFormVisible = true">
                添加学生
              </el-button>
              <span class="text-muted">共 {{ detail?.students.length ?? 0 }} 人</span>
            </div>
            <el-table :data="detail?.students ?? []" size="small" class="mt-12" empty-text="暂无学生">
              <el-table-column prop="studentNo" label="学号" width="140" />
              <el-table-column prop="name" label="姓名" width="120" />
              <el-table-column label="状态" width="100">
                <template #default="{ row }">
                  <el-tag size="small" effect="plain">{{ STUDENT_STATUS_LABELS[row.status as StudentStatus] }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="加入时间" width="180">
                <template #default="{ row }">{{ formatDate(row.createdAt, true) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="90">
                <template #default="{ row }">
                  <el-button link type="danger" @click="removeStudent(row)">移出</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="课程" name="courses">
            <el-table :data="detail?.courses ?? []" size="small" class="mt-12" empty-text="暂无课程">
              <el-table-column prop="name" label="课程" min-width="140" />
              <el-table-column label="任课教师" width="140">
                <template #default="{ row }">{{ row.teacher?.name ?? '-' }}</template>
              </el-table-column>
              <el-table-column label="操作" width="90">
                <template #default="{ row }">
                  <el-button link type="danger" @click="removeCourse(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-input
              v-model="courseForm.name"
              placeholder="输入课程名称后回车快速添加"
              class="mt-12"
              @keyup.enter="addCourse"
            />
          </el-tab-pane>

          <el-tab-pane label="任课老师" name="subjects">
            <el-alert type="info" :closable="false" class="mt-12">
              这是「班级 + 科目 + 教师」的任课关系：<b>科任老师只能发布 / 修改 / 删除自己任教科目的作业和成绩</b>；
              班主任若不教这一科，同样改不了这一科。同一位老师既可以是班主任、又可以教某一科 ——
              系统里只有他一个账号，权限自动合并，不会重复建号。
            </el-alert>
            <el-table :data="detail?.subjectTeachers ?? []" size="small" class="mt-12" empty-text="还没有配置任课老师">
              <el-table-column prop="subjectName" label="科目" width="140" />
              <el-table-column label="任课老师" width="260">
                <template #default="{ row }">
                  <el-select
                    v-if="isAdmin"
                    :model-value="row.teacherId"
                    placeholder="选择老师"
                    style="width: 220px"
                    filterable
                    @change="(value: string) => changeSubjectTeacher(row, value)"
                  >
                    <el-option
                      v-for="item in teachers"
                      :key="item.id"
                      :label="`${item.name}（${item.username}）`"
                      :value="item.id"
                    />
                  </el-select>
                  <span v-else>{{ row.teacherName || '-' }}</span>
                </template>
              </el-table-column>
              <el-table-column v-if="isAdmin" label="操作" width="110">
                <template #default="{ row }">
                  <el-button link type="danger" @click="clearSubjectTeacher(row)">解除</el-button>
                </template>
              </el-table-column>
            </el-table>

            <div v-if="isAdmin" class="toolbar mt-12">
              <el-select
                v-model="subjectDraft.subjectName"
                placeholder="选择科目"
                style="width: 180px"
                filterable
                allow-create
              >
                <el-option v-for="name in assignableSubjects" :key="name" :label="name" :value="name" />
              </el-select>
              <el-select v-model="subjectDraft.teacherId" placeholder="选择任课老师" style="width: 220px" filterable>
                <el-option
                  v-for="item in teachers"
                  :key="item.id"
                  :label="`${item.name}（${item.username}）`"
                  :value="item.id"
                />
              </el-select>
              <el-button type="primary" :loading="subjectSaving" @click="saveSubjectTeacher">设为任课老师</el-button>
            </div>
          </el-tab-pane>

          <el-tab-pane label="班级设置" name="settings">
            <div class="setting-row mt-12">
              <div>
                <div class="setting-title">ClassHelper 班级端按学号查询成绩明细</div>
                <div class="text-muted">
                  打开后，教室里那台 ClassHelper 班级端可以按学号查到本班学生的成绩明细（含等级）；
                  关闭后班级端查成绩一律 403，教师端不受影响。
                </div>
              </div>
              <el-switch
                :model-value="detail?.studentGradeQueryEnabled ?? true"
                :loading="gradeQuerySaving"
                :disabled="!isAdmin && auth.role !== 'TEACHER'"
                @change="(value: boolean) => toggleGradeQuery(value)"
              />
            </div>

            <el-divider />

            <div v-if="isAdmin" class="setting-row">
              <div>
                <div class="setting-title">学年升级</div>
                <div class="text-muted">
                  把本班年级改成下一学年（例如高一 → 高二）。<b>升级不归档</b>：
                  班级记录、学生名单、学号、作业与成绩全部沿用，只动「年级」这一个字段。
                </div>
              </div>
              <div class="toolbar">
                <el-input v-model="promoteForm.grade" placeholder="升级后的年级，如 高二" style="width: 200px" />
                <el-button type="primary" :loading="promoteForm.saving" @click="promote">升级</el-button>
              </div>
            </div>
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-drawer>

    <!-- 添加学生（只有名单：没有密码、不建账号） -->
    <el-dialog v-model="studentFormVisible" title="添加学生到本班" width="460px">
      <el-alert type="info" :closable="false" style="margin-bottom: 12px">
        学生只是班级名单里的记录：没有账号、没有密码、不能登录（教室机器统一用班级码 + 班级密码）。
        学号已存在时会直接转入本班，并留下一條调班历史。
      </el-alert>
      <el-form :model="studentForm" :rules="studentRules" label-width="100px">
        <el-form-item label="学号" prop="studentNo">
          <el-input v-model="studentForm.studentNo" placeholder="学生的唯一标识，如 202601" />
        </el-form-item>
        <el-form-item label="姓名" prop="name">
          <el-input v-model="studentForm.name" />
        </el-form-item>
        <el-form-item label="性别">
          <el-select v-model="studentForm.gender" placeholder="未填" clearable style="width: 100%">
            <el-option label="男" value="MALE" />
            <el-option label="女" value="FEMALE" />
          </el-select>
        </el-form-item>
        <el-form-item label="家长手机号">
          <el-input v-model="studentForm.guardianPhone" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="studentFormVisible = false">取消</el-button>
        <el-button type="primary" @click="addStudent">确认添加</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.account-tag {
  margin-left: 6px;
}
.mb-12 {
  margin-bottom: 12px;
}
.ml-8 {
  margin-left: 8px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}

.setting-title {
  font-weight: 600;
  margin-bottom: 4px;
}
</style>
