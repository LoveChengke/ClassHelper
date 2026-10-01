<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  CALL_QUICK_PHRASES,
  NOTIFICATION_PRIORITIES,
  PRIORITY_LABELS,
  PRIORITY_TAG_TYPES,
  SOCKET_EVENTS,
  formatDate,
  relativeTime,
  truncate,
  type ClassDto,
  type ClassPeriod,
  type NotificationDto,
  type NotificationPriority,
  type StudentDto,
} from '@classhelper/shared';
import { callApi, classApi, notificationApi, scheduleApi } from '@/api';
import { useRealtimeStore } from '@/stores/realtime';
import UrgentClassWarning from '@/components/UrgentClassWarning.vue';

const realtime = useRealtimeStore();
const route = useRoute();

const loading = ref(false);
const classes = ref<ClassDto[]>([]);
const notifications = ref<NotificationDto[]>([]);
const filter = reactive({ classId: '', priority: '', keyword: '' });

/**
 * 是否"单班视图"：选中了具体班级时列表只服务一个班。
 * 单班视图只展示"已读情况"（已读 N 人 / 未读），跨班视图才展示已读率百分比。
 */
const isSingleClass = computed(() => Boolean(filter.classId));

/**
 * 各班学生数（classId → 人数）。
 * NotificationDto 只有 readCount（已读人数），没有 unreadCount / reads，
 * 已读率的分母只能自己算，所以进入页面时按班级各取一次学生名单长度。
 */
const classStudentCounts = ref<Record<string, number>>({});

function classSizeOf(classId: string): number {
  return classStudentCounts.value[classId] ?? 0;
}

async function loadClasses(): Promise<void> {
  classes.value = await classApi.list();
  if (!filter.classId && classes.value.length > 0) filter.classId = classes.value[0]?.id ?? '';
  await loadClassStudentCounts();
}

async function loadClassStudentCounts(): Promise<void> {
  const entries = await Promise.all(
    classes.value.map(async (item) => {
      const students = await classApi.students(item.id).catch(() => []);
      return [item.id, students.length] as const;
    }),
  );
  classStudentCounts.value = Object.fromEntries(entries);
}

async function loadNotifications(): Promise<void> {
  loading.value = true;
  try {
    const params: { classId?: string; priority?: string; keyword?: string } = {};
    if (filter.classId) params.classId = filter.classId;
    if (filter.priority) params.priority = filter.priority;
    if (filter.keyword.trim()) params.keyword = filter.keyword.trim();
    notifications.value = await notificationApi.list(params);
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------ 叫人（教师可用） */

/**
 * 叫人入口放在通知页：班主任与科任老师都能用（学生管理页是管理员专属）。
 * 学生名单走 `/classes/:id/students`（班级详情接口，教师有权访问），
 * 不使用管理员专属的 `/students`。
 */
const callVisible = ref(false);
const callSending = ref(false);
const callClassId = ref('');
const callStudentId = ref('');
const callStudents = ref<StudentDto[]>([]);
const callQuickPhrase = ref<string>(CALL_QUICK_PHRASES[0] ?? '');
const callMessage = ref('');
/** 紧急叫人：无视上课时段立即展开；默认普通（只进队列，课后弹出） */
const callUrgent = ref(false);

async function openCall(): Promise<void> {
  callClassId.value = filter.classId || classes.value[0]?.id || '';
  callStudentId.value = '';
  callMessage.value = '';
  callQuickPhrase.value = CALL_QUICK_PHRASES[0] ?? '';
  callUrgent.value = false;
  callStudents.value = [];
  callVisible.value = true;
  if (callClassId.value) await loadCallStudents();
}

async function loadCallStudents(): Promise<void> {
  callStudentId.value = '';
  callStudents.value = callClassId.value ? await classApi.students(callClassId.value) : [];
}

function pickCallPhrase(phrase: string): void {
  callQuickPhrase.value = callQuickPhrase.value === phrase ? '' : phrase;
}

async function submitCall(): Promise<void> {
  if (!callClassId.value) {
    ElMessage.warning('请选择班级');
    return;
  }
  if (!callStudentId.value) {
    ElMessage.warning('请选择学生');
    return;
  }
  if (!callMessage.value.trim() && !callQuickPhrase.value.trim()) {
    ElMessage.warning('请选择快捷短语或填写自定义消息');
    return;
  }
  callSending.value = true;
  try {
    const created = await callApi.create({
      classId: callClassId.value,
      studentId: callStudentId.value,
      urgent: callUrgent.value,
      ...(callMessage.value.trim() ? { message: callMessage.value.trim() } : {}),
      ...(callQuickPhrase.value.trim() ? { quickPhrase: callQuickPhrase.value.trim() } : {}),
    });
    ElMessage.success(`已${callUrgent.value ? '紧急' : ''}通知：${created.title}`);
    callVisible.value = false;
  } finally {
    callSending.value = false;
  }
}

/* ------------------------------------------------------------ 发布 */

const formVisible = ref(false);
const formRef = ref<FormInstance>();
const form = reactive<{
  classIds: string[];
  title: string;
  content: string;
  priority: NotificationPriority;
}>({
  classIds: [],
  title: '',
  content: '',
  priority: 'NORMAL',
});

const rules: FormRules = {
  classIds: [{ required: true, type: 'array', min: 1, message: '请选择目标班级', trigger: 'change' }],
  title: [{ required: true, message: '请输入通知标题', trigger: 'blur' }],
  content: [{ required: true, message: '请输入通知内容', trigger: 'blur' }],
};

/** 上课时段发布紧急通知的全屏二次确认状态（classIds = 本次要发布的班级） */
const urgentWarning = reactive({
  visible: false,
  period: null as ClassPeriod | null,
  title: '',
  classIds: [] as string[],
});

function classNameOf(classId: string): string {
  return classes.value.find((item) => item.id === classId)?.name ?? classId;
}

async function openCreate(): Promise<void> {
  // 班级列表可能还没加载完（进入页面后立刻点按钮）：先补一次，避免「目标班级」为空导致校验失败
  if (classes.value.length === 0) await loadClasses().catch(() => undefined);
  form.classIds = filter.classId ? [filter.classId] : classes.value[0] ? [classes.value[0].id] : [];
  form.title = '';
  form.content = '';
  form.priority = 'NORMAL';
  formVisible.value = true;
}

/**
 * 上课时段检查：多班发布时逐班查询（GET /api/schedules/current?classId=...），
 * 任一班级正在上课就需要二次确认；返回命中的班级与时段。
 */
async function findClassInSession(
  classIds: string[],
): Promise<{ classId: string; period: ClassPeriod | null } | null> {
  const results = await Promise.all(
    classIds.map(async (classId) => {
      const status = await scheduleApi.classStatus(classId).catch(() => null);
      return status?.inClass ? { classId, period: status.current } : null;
    }),
  );
  return results.find((item) => item !== null) ?? null;
}

async function submitForm(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  const classIds = [...form.classIds];
  if (classIds.length === 0) {
    ElMessage.warning('请至少选择一个目标班级');
    return;
  }

  // 上课时段发布紧急通知：先查询所有目标班级的上课状态，任一命中则弹全屏二次确认（3 秒倒计时）
  if (form.priority === 'URGENT') {
    const hit = await findClassInSession(classIds);
    if (hit) {
      urgentWarning.period = hit.period;
      urgentWarning.title = form.title.trim();
      urgentWarning.classIds = classIds;
      urgentWarning.visible = true;
      return;
    }
  }

  await doPublish(classIds, false);
}

/** 单个班级的发布失败信息（用于汇总提示） */
interface PublishFailure {
  classId: string;
  reason: string;
  /** 服务端因"上课时段紧急通知"拦截（409 URGENT_DURING_CLASS） */
  urgentConflict: boolean;
  period: ClassPeriod | null;
}

/**
 * 真正提交：对每个班级各调一次 `POST /api/notifications`（Promise.allSettled），
 * confirmDuringClass 为 true 表示教师已在上课警告中确认。
 */
async function doPublish(classIds: string[], confirmDuringClass: boolean): Promise<void> {
  if (classIds.length === 0) return;

  const payload = {
    title: form.title.trim(),
    content: form.content,
    priority: form.priority,
    ...(confirmDuringClass ? { confirmDuringClass: true } : {}),
  };

  const settled = await Promise.allSettled(
    classIds.map((classId) => notificationApi.create({ ...payload, classId })),
  );

  let successCount = 0;
  const failures: PublishFailure[] = [];

  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      successCount += 1;
      return;
    }
    const response = (
      result.reason as {
        response?: {
          status?: number;
          data?: { code?: string; message?: string; details?: { current?: ClassPeriod | null } };
        };
      }
    ).response;
    failures.push({
      classId: classIds[index] ?? '',
      reason:
        response?.data?.message ?? (result.reason instanceof Error ? result.reason.message : '发布失败'),
      urgentConflict: response?.status === 409 && response?.data?.code === 'URGENT_DURING_CLASS',
      period: response?.data?.details?.current ?? null,
    });
  });

  // 兜底：并发场景下服务端仍可能拦截（例如刚好上课铃响），对这批班级重新走一次二次确认
  const conflicted = failures.filter((item) => item.urgentConflict);
  const pendingConfirm = !confirmDuringClass && conflicted.length > 0;
  if (pendingConfirm) {
    urgentWarning.period = conflicted[0]?.period ?? null;
    urgentWarning.title = form.title.trim();
    urgentWarning.classIds = conflicted.map((item) => item.classId);
    urgentWarning.visible = true;
  }

  const reported = confirmDuringClass ? failures : failures.filter((item) => !item.urgentConflict);
  reportPublishResult(successCount, reported);

  if (successCount > 0) {
    // 有班级发布成功：关掉弹窗并刷新列表；只有"还有班级等着二次确认"时才保留弹窗内的数据。
    // 注意这里是 pendingConfirm 而不是 !pendingConfirm —— 写成取反会让弹窗在**发布成功后仍然开着**，
    // 老师以为没发出去再点一次「立即发布」，同一批班级就重复收到通知（还会重复广播与推 ClassIsland）。
    formVisible.value = pendingConfirm;
    await loadNotifications();
  }
}

/** 多班发布结果汇总：成功 N 个班、失败 M 个班（失败列出班级名 + 原因） */
function reportPublishResult(successCount: number, failures: PublishFailure[]): void {
  if (successCount === 0 && failures.length === 0) return;
  if (failures.length === 0) {
    ElMessage.success(`通知已发布到 ${successCount} 个班级，已推送给学生客户端`);
    return;
  }
  const detail = failures.map((item) => `${classNameOf(item.classId)}（${item.reason}）`).join('；');
  ElMessage({
    type: successCount > 0 ? 'warning' : 'error',
    message: `成功 ${successCount} 个班，失败 ${failures.length} 个班｜${detail}`,
    duration: 6000,
    showClose: true,
  });
}

function onUrgentConfirmed(): void {
  const classIds = [...urgentWarning.classIds];
  urgentWarning.visible = false;
  urgentWarning.classIds = [];
  void doPublish(classIds, true);
}

function onUrgentCancelled(): void {
  urgentWarning.visible = false;
  urgentWarning.classIds = [];
  ElMessage.info('已取消发布，紧急通知未发出');
}

async function removeNotification(row: NotificationDto): Promise<void> {
  await ElMessageBox.confirm(`删除通知「${row.title}」？`, '确认', { type: 'warning' });
  await notificationApi.remove(row.id);
  ElMessage.success('已删除');
  await loadNotifications();
}

/** 已读率（跨班视图使用）：分母按该通知所属班级的学生数算 */
function readRate(row: NotificationDto): number {
  const total = classSizeOf(row.classId);
  if (!total) return 0;
  return Math.round(((row.readCount ?? 0) / total) * 100);
}

function onNotificationEvent(): void {
  void loadNotifications();
}

/**
 * 从仪表盘点「最新通知」跳过来时带的 `?highlight=<通知 id>`：
 * 高亮那一行并滚动过去。之前这个参数没有任何人消费，
 * 用户点完只是跳到通知列表，看不出去的是哪一条。
 */
const highlightedId = computed(() => {
  const value = route.query.highlight;
  return typeof value === 'string' ? value : '';
});

function rowClassName({ row }: { row: NotificationDto }): string {
  return row.id === highlightedId.value ? 'row-highlight' : '';
}

onMounted(async () => {
  await loadClasses();
  await loadNotifications();
  realtime.on(SOCKET_EVENTS.notificationNew, onNotificationEvent);
  // 列表渲染完再滚动，否则表格行还没生成
  if (highlightedId.value) {
    await nextTick();
    document.querySelector('.row-highlight')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
});

onUnmounted(() => {
  realtime.off(SOCKET_EVENTS.notificationNew, onNotificationEvent);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">通知发布</h2>
        <p class="page-subtitle">发布后按班级房间广播（notification:new），学生端 5 秒内到达</p>
      </div>
      <div class="toolbar">
        <el-select
          v-model="filter.classId"
          placeholder="选择班级"
          clearable
          style="width: 170px"
          @change="loadNotifications"
        >
          <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <el-select
          v-model="filter.priority"
          placeholder="全部优先级"
          clearable
          style="width: 150px"
          @change="loadNotifications"
        >
          <el-option
            v-for="item in NOTIFICATION_PRIORITIES"
            :key="item"
            :label="PRIORITY_LABELS[item]"
            :value="item"
          />
        </el-select>
        <el-input
          v-model="filter.keyword"
          placeholder="搜索标题/内容"
          clearable
          style="width: 170px"
          @keyup.enter="loadNotifications"
          @clear="loadNotifications"
        />
        <el-button type="warning" :icon="'Bell'" @click="openCall">叫人</el-button>
        <el-button type="primary" :icon="'Plus'" @click="openCreate">发布通知</el-button>
      </div>
    </div>

    <el-card shadow="never" class="table-card">
      <el-table
        v-loading="loading"
        :data="notifications"
        empty-text="暂无通知"
        :row-class-name="rowClassName"
      >
        <el-table-column label="优先级" width="90">
          <template #default="{ row }">
            <el-tag
              :type="PRIORITY_TAG_TYPES[row.priority as NotificationPriority]"
              size="small"
              effect="light"
            >
              {{ PRIORITY_LABELS[row.priority as NotificationPriority] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
        <el-table-column label="内容摘要" min-width="220">
          <template #default="{ row }">{{ truncate(row.content, 40) }}</template>
        </el-table-column>
        <el-table-column label="发布人" width="110">
          <template #default="{ row }">{{ row.creator?.name ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="发布时间" width="170">
          <template #default="{ row }">
            <div>{{ formatDate(row.createdAt, true) }}</div>
            <div class="text-muted">{{ relativeTime(row.createdAt) }}</div>
          </template>
        </el-table-column>
        <el-table-column :label="isSingleClass ? '已读情况' : '已读率'" width="150">
          <template #default="{ row }">
            <!--
              单班视图：只显示该通知的已读情况（不显示百分比）。
              NotificationDto 只有 readCount（已读人数），没有 unreadCount / reads 明细，
              所以这里用「已读 N 人 / 未读」标签 + 班级总人数表达已读情况。
            -->
            <template v-if="isSingleClass">
              <el-tag :type="(row.readCount ?? 0) > 0 ? 'success' : 'info'" size="small" effect="light">
                {{ (row.readCount ?? 0) > 0 ? `已读 ${row.readCount} 人` : '未读' }}
              </el-tag>
              <div class="text-muted">共 {{ classSizeOf(row.classId) }} 人</div>
            </template>
            <!-- 跨班视图（未选具体班级）：显示已读率百分比，分母按该通知所属班级算 -->
            <template v-else>
              <el-progress :percentage="readRate(row)" :stroke-width="10" />
              <span class="text-muted">{{ row.readCount ?? 0 }}/{{ classSizeOf(row.classId) }} 人</span>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link type="danger" @click="removeNotification(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="formVisible" title="发布通知" width="560px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="目标班级" prop="classIds">
          <el-select
            v-model="form.classIds"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            placeholder="可多选；发布时逐班提交"
            style="width: 100%"
          >
            <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="优先级">
          <el-radio-group v-model="form.priority">
            <el-radio-button v-for="item in NOTIFICATION_PRIORITIES" :key="item" :value="item">
              {{ PRIORITY_LABELS[item] }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="标题" prop="title">
          <el-input v-model="form.title" maxlength="120" show-word-limit />
        </el-form-item>
        <el-form-item label="内容" prop="content">
          <el-input v-model="form.content" type="textarea" :rows="5" maxlength="5000" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm">立即发布</el-button>
      </template>
    </el-dialog>

    <!-- 叫人：选班级 → 选学生 → 快捷短语 / 自定义消息 → 学生端灵动岛立即弹出 -->
    <el-dialog v-model="callVisible" title="叫人" width="520px">
      <el-form label-width="76px">
        <el-form-item label="班级">
          <el-select v-model="callClassId" style="width: 100%" @change="loadCallStudents">
            <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="学生">
          <el-select v-model="callStudentId" filterable placeholder="选择学生" style="width: 100%">
            <el-option
              v-for="item in callStudents"
              :key="item.id"
              :label="`${item.name}（${item.username}）`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="快捷短语">
          <div class="call-phrases">
            <el-tag
              v-for="phrase in CALL_QUICK_PHRASES"
              :key="phrase"
              class="call-phrase"
              :effect="callQuickPhrase === phrase ? 'dark' : 'plain'"
              :type="callQuickPhrase === phrase ? 'warning' : 'info'"
              @click="pickCallPhrase(phrase)"
            >
              {{ phrase }}
            </el-tag>
          </div>
        </el-form-item>
        <el-form-item label="自定义">
          <el-input
            v-model="callMessage"
            type="textarea"
            :rows="2"
            maxlength="200"
            show-word-limit
            placeholder="可选；填写后优先于快捷短语"
          />
        </el-form-item>
        <el-form-item label="级别">
          <el-radio-group v-model="callUrgent">
            <el-radio-button :value="false">普通（不打断课堂）</el-radio-button>
            <el-radio-button :value="true">紧急（立即展开）</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <el-alert
        :type="callUrgent ? 'error' : 'warning'"
        :closable="false"
        :title="
          callUrgent
            ? '紧急叫人：学生端桌面无视上课时段立即展开，需学生点「收到」'
            : '普通叫人：学生端课间先显示胶囊、点击展开；上课时段只排队，下课后弹出'
        "
      />
      <template #footer>
        <el-button @click="callVisible = false">取消</el-button>
        <el-button type="warning" :loading="callSending" @click="submitCall">发送叫人</el-button>
      </template>
    </el-dialog>
    <!-- 上课时段发布紧急通知的全屏二次确认（3 秒倒计时） -->
    <UrgentClassWarning
      :visible="urgentWarning.visible"
      :period="urgentWarning.period"
      :pending-title="urgentWarning.title"
      @cancel="onUrgentCancelled"
      @confirm="onUrgentConfirmed"
    />
  </div>
</template>

<style scoped>
/* 从仪表盘点「最新通知」跳转过来的定位高亮（?highlight=<通知 id>） */
:deep(.row-highlight) td {
  background: var(--el-color-primary-light-9) !important;
}
</style>
