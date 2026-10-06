<script setup lang="ts">
/**
 * 毕业归档（仅管理员）。
 *
 * 归档是**打标记 + 只读**，不删任何数据：
 * - 毕业班级与学生挂到 `ArchivedYear` 上，常规的班级/学生列表据此过滤；
 * - 毕业班级发过的**作业与通知原样留在库里**，在「届别详情 → 查看班级内容」里只读浏览；
 * - **未毕业而升级的班级不归档** —— 升级只在「班级管理 → 班级设置」里改年级，数据继续沿用。
 *
 * 撤销归档是误操作的退路：把班级与学生还原成在读，同样不删数据。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  STUDENT_STATUS_LABELS,
  STUDENT_STATUS_TAG_TYPES,
  formatDate,
  type ArchivedClassContentDto,
  type ArchivedClassDto,
  type ArchivedYearDetailDto,
  type ArchivedYearDto,
  type StudentStatus,
} from '@classhelper/shared';
import { archiveApi } from '@/api';

const loading = ref(false);
const years = ref<ArchivedYearDto[]>([]);
const summary = ref<{
  archiveCount: number;
  classCount: number;
  graduateCount: number;
  transferredCount: number;
  suggestedEnrollmentYears: number[];
} | null>(null);

async function loadYears(): Promise<void> {
  loading.value = true;
  try {
    const [list, overview] = await Promise.all([archiveApi.list(), archiveApi.summary()]);
    years.value = list;
    summary.value = overview;
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------ 届别详情 */

const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<ArchivedYearDetailDto | null>(null);
const activeTab = ref('classes');

async function openDetail(row: ArchivedYearDto): Promise<void> {
  detailVisible.value = true;
  detailLoading.value = true;
  activeTab.value = 'classes';
  try {
    detail.value = await archiveApi.detail(row.id);
  } finally {
    detailLoading.value = false;
  }
}

/* ------------------------------------------------------------ 归档班级的作业与通知（只读） */

const contentVisible = ref(false);
const contentLoading = ref(false);
const content = ref<ArchivedClassContentDto | null>(null);

async function openContent(row: ArchivedClassDto): Promise<void> {
  if (!detail.value) return;
  contentVisible.value = true;
  contentLoading.value = true;
  content.value = null;
  try {
    content.value = await archiveApi.classContent(detail.value.id, row.id);
  } finally {
    contentLoading.value = false;
  }
}

/* ------------------------------------------------------------ 执行归档 */

const createVisible = ref(false);
const creating = ref(false);
const createForm = reactive({ enrollmentYear: new Date().getFullYear() - 3, note: '' });

/** 已经归档过的届别（下拉里标出来，避免重复提交） */
const archivedYears = computed(() => new Set(years.value.map((item) => item.enrollmentYear)));

function openCreate(): void {
  const suggested = summary.value?.suggestedEnrollmentYears ?? [];
  createForm.enrollmentYear = suggested.find((year) => !archivedYears.value.has(year)) ?? suggested[0] ?? createForm.enrollmentYear;
  createForm.note = '';
  createVisible.value = true;
}

async function submitCreate(): Promise<void> {
  creating.value = true;
  try {
    const result = await archiveApi.create({
      enrollmentYear: createForm.enrollmentYear,
      ...(createForm.note.trim() ? { note: createForm.note.trim() } : {}),
    });
    ElMessage.success(
      `${result.name} 已归档：${result.classCount} 个班级、${result.studentCount} 名毕业生、${result.transferredCount} 名转出`,
    );
    createVisible.value = false;
    await loadYears();
  } finally {
    creating.value = false;
  }
}

/** 撤销归档：班级与学生回到在读，不删任何数据 */
async function undo(row: ArchivedYearDto): Promise<void> {
  await ElMessageBox.confirm(
    `撤销「${row.name}」的毕业归档？\n` +
      '该届班级会回到在读列表、毕业学生会恢复为在读；作业、通知与成绩一条都不会被删除。',
    '撤销归档',
    { type: 'warning', confirmButtonText: '确认撤销' },
  );
  await archiveApi.remove(row.id);
  ElMessage.success('已撤销归档');
  detailVisible.value = false;
  await loadYears();
}

onMounted(loadYears);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">毕业归档</h2>
        <p class="page-subtitle">
          按年度归档毕业的班级与学生、当年转出的学生，以及毕业班级发过的作业与通知。
          <b>归档不删数据</b>；未毕业而升级的班级不归档，数据继续沿用
        </p>
      </div>
      <div class="toolbar">
        <el-button :icon="'Refresh'" :loading="loading" @click="loadYears">刷新</el-button>
        <el-button type="primary" :icon="'FolderAdd'" @click="openCreate">归档届别</el-button>
      </div>
    </div>

    <el-row :gutter="12" style="margin-bottom: 12px">
      <el-col :xs="12" :md="6">
        <div class="stat-card">
          <div class="stat-label">已归档届别</div>
          <div class="stat-value">{{ summary?.archiveCount ?? 0 }}</div>
        </div>
      </el-col>
      <el-col :xs="12" :md="6">
        <div class="stat-card">
          <div class="stat-label">归档班级</div>
          <div class="stat-value">{{ summary?.classCount ?? 0 }}</div>
        </div>
      </el-col>
      <el-col :xs="12" :md="6">
        <div class="stat-card">
          <div class="stat-label">已毕业学生</div>
          <div class="stat-value">{{ summary?.graduateCount ?? 0 }}</div>
        </div>
      </el-col>
      <el-col :xs="12" :md="6">
        <div class="stat-card">
          <div class="stat-label">已转出学生</div>
          <div class="stat-value">{{ summary?.transferredCount ?? 0 }}</div>
        </div>
      </el-col>
    </el-row>

    <el-card shadow="never" class="table-card">
      <el-table v-loading="loading" :data="years" empty-text="还没有归档记录">
        <el-table-column prop="name" label="届别" width="120" />
        <el-table-column label="入学 / 毕业" width="160">
          <template #default="{ row }">{{ row.enrollmentYear }} → {{ row.graduationYear }}</template>
        </el-table-column>
        <el-table-column label="班级" width="80">
          <template #default="{ row }">{{ row.classCount }}</template>
        </el-table-column>
        <el-table-column label="毕业生" width="90">
          <template #default="{ row }">{{ row.studentCount }}</template>
        </el-table-column>
        <el-table-column label="转出学生" width="100">
          <template #default="{ row }">{{ row.transferredCount }}</template>
        </el-table-column>
        <el-table-column label="作业" width="80">
          <template #default="{ row }">{{ row.homeworkCount }}</template>
        </el-table-column>
        <el-table-column label="通知" width="80">
          <template #default="{ row }">{{ row.notificationCount }}</template>
        </el-table-column>
        <el-table-column label="归档时间" width="170">
          <template #default="{ row }">{{ formatDate(row.archivedAt, true) }}</template>
        </el-table-column>
        <el-table-column prop="operatorName" label="操作人" width="110" />
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button link type="danger" @click="undo(row)">撤销归档</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 届别详情：班级 / 毕业生 / 转出的学生 -->
    <el-drawer v-model="detailVisible" size="68%" :title="detail ? `${detail.name} · 归档详情` : '归档详情'">
      <div v-loading="detailLoading">
        <el-alert v-if="detail?.note" type="info" :closable="false" style="margin-bottom: 12px" :title="detail.note" />

        <el-tabs v-model="activeTab">
          <el-tab-pane label="班级" name="classes">
            <el-table :data="detail?.classes ?? []" size="small" class="mt-12" empty-text="该届没有班级">
              <el-table-column prop="name" label="班级" width="130" />
              <el-table-column prop="grade" label="毕业时年级" width="110" />
              <el-table-column label="班主任" width="110">
                <template #default="{ row }">{{ row.headTeacherName ?? '-' }}</template>
              </el-table-column>
              <el-table-column label="学生" width="80">
                <template #default="{ row }">{{ row.studentCount }}</template>
              </el-table-column>
              <el-table-column label="作业" width="80">
                <template #default="{ row }">{{ row.homeworkCount }}</template>
              </el-table-column>
              <el-table-column label="通知" width="80">
                <template #default="{ row }">{{ row.notificationCount }}</template>
              </el-table-column>
              <el-table-column label="操作" width="140">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openContent(row)">看作业与通知</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane :label="`毕业生（${detail?.graduates.length ?? 0}）`" name="graduates">
            <el-table :data="detail?.graduates ?? []" size="small" class="mt-12" empty-text="没有毕业生">
              <el-table-column prop="studentNo" label="学号" width="140" />
              <el-table-column prop="name" label="姓名" width="120" />
              <el-table-column label="毕业前班级" min-width="140">
                <template #default="{ row }">{{ row.className ?? '-' }}</template>
              </el-table-column>
              <el-table-column label="状态" width="100">
                <template #default="{ row }">
                  <el-tag size="small" :type="STUDENT_STATUS_TAG_TYPES[row.status as StudentStatus]">
                    {{ STUDENT_STATUS_LABELS[row.status as StudentStatus] }}
                  </el-tag>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane :label="`转出学生（${detail?.transferred.length ?? 0}）`" name="transferred">
            <el-table :data="detail?.transferred ?? []" size="small" class="mt-12" empty-text="该届没有转出的学生">
              <el-table-column prop="studentNo" label="学号" width="140" />
              <el-table-column prop="name" label="姓名" width="120" />
              <el-table-column label="转出前班级" min-width="140">
                <template #default="{ row }">{{ row.className ?? '-' }}</template>
              </el-table-column>
              <el-table-column label="转出时间" width="170">
                <template #default="{ row }">{{ formatDate(row.transferredAt, true) }}</template>
              </el-table-column>
              <el-table-column prop="transferNote" label="去向 / 备注" show-overflow-tooltip />
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-drawer>

    <!-- 归档班级的作业与通知（只读） -->
    <el-drawer v-model="contentVisible" size="60%" :title="content ? `${content.className} · 作业与通知` : '作业与通知'">
      <div v-loading="contentLoading">
        <el-tabs>
          <el-tab-pane :label="`作业（${content?.homeworks.length ?? 0}）`">
            <el-table :data="content?.homeworks ?? []" size="small" class="mt-12" empty-text="没有作业记录">
              <el-table-column prop="assignDate" label="日期" width="120" />
              <el-table-column prop="title" label="标题" min-width="160" show-overflow-tooltip />
              <el-table-column label="科目" width="100">
                <template #default="{ row }">{{ row.course?.name ?? '-' }}</template>
              </el-table-column>
              <el-table-column label="发布人" width="110">
                <template #default="{ row }">{{ row.creator?.name ?? '-' }}</template>
              </el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane :label="`通知（${content?.notifications.length ?? 0}）`">
            <el-table :data="content?.notifications ?? []" size="small" class="mt-12" empty-text="没有通知记录">
              <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
              <el-table-column prop="content" label="内容" min-width="220" show-overflow-tooltip />
              <el-table-column label="发布时间" width="170">
                <template #default="{ row }">{{ formatDate(row.createdAt, true) }}</template>
              </el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-drawer>

    <!-- 执行归档 -->
    <el-dialog v-model="createVisible" title="归档一个届别" width="520px">
      <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 12px">
        <template #title>归档不删数据</template>
        <template #default>
          该届的班级会从常规列表里隐去、在读学生标记为「已毕业」；
          作业、通知、成绩全部原样保留，可在归档详情里查看。填错届别可以用「撤销归档」还原。
        </template>
      </el-alert>
      <el-form label-width="100px">
        <el-form-item label="届别（入学年）">
          <el-select v-model="createForm.enrollmentYear" filterable allow-create style="width: 100%">
            <el-option
              v-for="year in summary?.suggestedEnrollmentYears ?? []"
              :key="year"
              :label="`${year} 级${archivedYears.has(year) ? '（已归档）' : ''}`"
              :value="year"
              :disabled="archivedYears.has(year)"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="createForm.note" maxlength="200" placeholder="例如：2026 年 6 月毕业（可选）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">确认归档</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-card {
  background: var(--ch-surface);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--ch-radius-lg);
  padding: 14px 16px;
  margin-bottom: 12px;
}

.stat-label {
  font-size: 13px;
  color: var(--ch-text-secondary);
}

.stat-value {
  font-size: 24px;
  font-weight: 600;
  margin-top: 4px;
}
</style>
