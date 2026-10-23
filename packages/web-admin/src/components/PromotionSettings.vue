<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { type PromotionPlan } from '@classhelper/shared';
import { api } from '@/api/http';
type Run = {
  year: number;
  status: string;
  message: string;
  classCount: number;
  studentCount: number;
  snapshotPath: string;
  snapshotSha256: string;
  operatorName: string;
  detailsJson: string;
  error: string;
};
type Preview = {
  year: number;
  planHash: string;
  classCount: number;
  studentCount: number;
  blockers: { code: string; message: string }[];
  warnings: string[];
  termWeekDeleteCount: number;
  termStartDate: string;
  tracks: {
    id: string;
    name: string;
    classes: {
      id: string;
      name: string;
      grade: string;
      nextGrade: string;
      active: number;
      inactive: number;
      transferred: number;
    }[];
    newClasses: { name: string; grade: string; code: string }[];
  }[];
};
type Status = {
  config: { month: number; day: number; hour: number; classCount: number };
  plan: PromotionPlan;
  year: number;
  pending: boolean;
  runs: Run[];
};
const status = ref<Status>();
const preview = ref<Preview>();
const year = ref(2026);
const visible = ref(false),
  saving = ref(false),
  running = ref(false),
  loading = ref(false);
async function load() {
  status.value = await api.get('/term/promotion');
  year.value = status.value!.year;
}
function normalizeStages() {
  for (const track of status.value?.plan.tracks ?? [])
    track.stages.forEach((stage, i) => {
      stage.terminal = i === track.stages.length - 1;
    });
}
function addTrack() {
  status.value?.plan.tracks.push({
    id: `track-${Date.now().toString(36)}`,
    name: '新轨道',
    entryClassCount: 0,
    stages: [{ grade: '', terminal: true }],
  });
}
function moveStage(track: PromotionPlan['tracks'][number], index: number, direction: number) {
  const next = index + direction;
  if (next < 0 || next >= track.stages.length) return;
  [track.stages[index], track.stages[next]] = [track.stages[next], track.stages[index]];
  normalizeStages();
}
async function save() {
  if (!status.value) return;
  normalizeStages();
  saving.value = true;
  try {
    await api.put('/term/promotion', { ...status.value.config, plan: status.value.plan });
    preview.value = undefined;
    await load();
    ElMessage.success('升级计划已保存');
  } finally {
    saving.value = false;
  }
}
async function showPreview() {
  loading.value = true;
  try {
    preview.value = await api.post('/term/promotion/preview', { year: year.value });
    visible.value = true;
  } finally {
    loading.value = false;
  }
}
async function execute() {
  if (!preview.value || running.value) return;
  const { year: target, planHash } = preview.value;
  await ElMessageBox.prompt(
    `请输入 ${target} 确认执行。快照可供手工恢复；撤销归档不会回滚年级、新班或周次。`,
    '确认学年升级',
    {
      inputValidator: (value) => value === String(target) || '输入必须与预览学年一致',
      confirmButtonText: '执行升级',
      type: 'warning',
    },
  );
  running.value = true;
  try {
    await api.post('/term/promotion/run', { year: target, planHash, confirm: true, catchUp: true });
    visible.value = false;
    await load();
    ElMessage.success('学年升级完成，快照与执行明细已保留');
  } finally {
    running.value = false;
  }
}
onMounted(load);
</script>
<template>
  <el-card v-if="status" shadow="never">
    <h3>学年升级计划</h3>
    <el-alert
      title="先保存计划，再预览影响。执行前保存全库快照；恢复整学年需要管理员手工恢复快照。"
      type="info"
      :closable="false"
    />
    <el-form label-position="top" :disabled="saving || running">
      <div class="toolbar">
        <el-form-item label="执行月份">
          <el-input-number v-model="status.config.month" :min="1" :max="12" />
        </el-form-item>
        <el-form-item label="执行日期">
          <el-input-number v-model="status.config.day" :min="1" :max="31" />
        </el-form-item>
        <el-form-item label="执行小时">
          <el-input-number v-model="status.config.hour" :min="0" :max="23" />
        </el-form-item>
        <el-form-item label="新学期开学日（空则当年 9 月 1 日）">
          <el-date-picker
            v-model="status.plan.termStartDate"
            type="date"
            value-format="YYYY-MM-DD"
            clearable
          />
        </el-form-item>
        <el-form-item label="周次区间处理">
          <el-switch
            v-model="status.plan.resetTermWeeks"
            active-text="重置全校及班级周次"
            inactive-text="保留原周次"
          />
        </el-form-item>
      </div>
      <el-card v-for="(track, ti) in status.plan.tracks" :key="track.id" shadow="never" class="track-card">
        <div class="toolbar">
          <el-form-item label="轨道名称"><el-input v-model="track.name" /></el-form-item>
          <el-form-item label="起始年级新班数">
            <el-input-number v-model="track.entryClassCount" :min="0" :max="99" />
          </el-form-item>
          <el-button
            :disabled="status.plan.tracks.length === 1"
            type="danger"
            plain
            @click="status.plan.tracks.splice(ti, 1)"
          >
            删除轨道
          </el-button>
        </div>
        <div v-for="(stage, si) in track.stages" :key="si" class="toolbar stage-row">
          <el-form-item :label="`第 ${si + 1} 学段`">
            <el-input v-model="stage.grade" placeholder="填写年级名称" />
          </el-form-item>
          <el-tag v-if="si === track.stages.length - 1" type="warning">毕业学段</el-tag>
          <el-button :disabled="si === 0" @click="moveStage(track, si, -1)">上移</el-button>
          <el-button :disabled="si === track.stages.length - 1" @click="moveStage(track, si, 1)">
            下移
          </el-button>
          <el-button
            :disabled="track.stages.length === 1"
            @click="
              track.stages.splice(si, 1);
              normalizeStages();
            "
          >
            移除学段
          </el-button>
        </div>
        <el-button
          @click="
            track.stages.push({ grade: '', terminal: true });
            normalizeStages();
          "
        >
          添加学段
        </el-button>
      </el-card>
      <div class="toolbar">
        <el-button @click="addTrack">添加轨道</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存计划</el-button>
      </div>
    </el-form>
    <div class="toolbar preview-toolbar">
      <el-form-item label="预览学年">
        <el-input-number v-model="year" :min="2000" :max="status.year" />
      </el-form-item>
      <el-button :loading="loading" @click="showPreview">预览已保存计划</el-button>
      <el-tag :type="status.pending ? 'warning' : 'success'">
        {{ status.pending ? `待执行 ${status.year} 学年` : '应执行学年已完成' }}
      </el-tag>
    </div>
    <h4>执行记录</h4>
    <el-table :data="status.runs">
      <el-table-column prop="year" label="学年" width="90" />
      <el-table-column prop="status" label="状态" width="100" />
      <el-table-column prop="operatorName" label="操作人" min-width="130" />
      <el-table-column prop="classCount" label="班级" width="80" />
      <el-table-column prop="studentCount" label="在读学生" width="100" />
      <el-table-column label="记录与快照" min-width="350">
        <template #default="{ row }">
          <details>
            <summary>{{ row.error || row.message }}</summary>
            <p class="digest">
              快照：{{ row.snapshotPath }}
              <br />
              SHA256：{{ row.snapshotSha256 }}
            </p>
            <pre>{{ row.detailsJson }}</pre>
          </details>
        </template>
      </el-table-column>
    </el-table>
    <el-drawer v-model="visible" title="学年升级影响预览" size="90%" :close-on-click-modal="!running">
      <template v-if="preview">
        <p>
          {{ preview.year }} 学年 · {{ preview.classCount }} 个班 · {{ preview.studentCount }} 名在读学生 ·
          开学日 {{ preview.termStartDate }} · 删除周次 {{ preview.termWeekDeleteCount }} 条
        </p>
        <el-alert
          v-for="block in preview.blockers"
          :key="block.message"
          :title="block.message"
          type="error"
          :closable="false"
        />
        <el-alert
          v-for="warning in preview.warnings"
          :key="warning"
          :title="warning"
          type="warning"
          :closable="false"
        />
        <section v-for="track in preview.tracks" :key="track.id">
          <h4>{{ track.name }}</h4>
          <el-table :data="track.classes">
            <el-table-column prop="name" label="班级" min-width="150" />
            <el-table-column prop="grade" label="当前年级" />
            <el-table-column prop="nextGrade" label="处理结果" />
            <el-table-column prop="active" label="在读" />
            <el-table-column prop="inactive" label="停用" />
            <el-table-column prop="transferred" label="转出" />
          </el-table>
          <el-table :data="track.newClasses" empty-text="不新建班级">
            <el-table-column prop="name" label="新班" />
            <el-table-column prop="grade" label="年级" />
            <el-table-column prop="code" label="班级码" />
          </el-table>
        </section>
        <p class="digest">计划哈希：{{ preview.planHash }}</p>
        <el-button type="danger" :disabled="preview.blockers.length > 0" :loading="running" @click="execute">
          确认学年并执行
        </el-button>
      </template>
    </el-drawer>
  </el-card>
</template>
<style scoped>
.track-card,
.preview-toolbar {
  margin-top: 16px;
  margin-bottom: 16px;
}
.stage-row {
  margin-bottom: 8px;
}
.digest,
pre {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
