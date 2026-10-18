<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  COURSEWARE_CATEGORIES,
  COURSEWARE_MAX_BYTES,
  COURSEWARE_TRANSFER_TIMEOUT_MS,
  type CoursewareDto,
  type CoursewareClassDto,
  type CoursewareUploadRequest,
  type CoursewareFolderDto,
} from '@classhelper/shared';
import { api } from '@/api/http';
import { useAuthStore } from '@/stores/auth';
import { useResponsive } from '@/composables/useResponsive';
const auth = useAuthStore();
const { isMobile } = useResponsive();
const items = ref<CoursewareDto[]>([]),
  classes = ref<CoursewareClassDto[]>([]);
const file = ref<File | null>(null),
  classIds = ref<string[]>([]),
  mode = ref<'cloud' | 'push'>('cloud');
const fileInput = ref<HTMLInputElement>();
const loading = ref(false),
  uploading = ref(false),
  progress = ref(0),
  query = ref(''),
  category = ref(''),
  date = ref('');
const scopeItem = ref<CoursewareDto | null>(null),
  scopeIds = ref<string[]>([]),
  scopeMode = ref<'visibility' | 'push'>('visibility'),
  saving = ref(false);
const canWrite = computed(() => auth.can('courseware:write'));
const folders = ref<CoursewareFolderDto[]>([]),
  folderPath = ref(''),
  folderFilter = ref('');
const grouping = ref<'date' | 'folder'>('date');
const dateFolder = ref('');
const dateFolders = computed(() =>
  [
    ...new Set(
      items.value.map((item) => item.archivePath?.split('/').slice(0, -1).join('/') || item.archiveDate),
    ),
  ]
    .sort()
    .reverse(),
);
async function newFolder() {
  try {
    const { value } = await ElMessageBox.prompt(
      '输入文件夹名称，可用 / 创建多层分类，如 地理/必修一',
      '新建文件夹',
    );
    const path = String(value ?? '').trim();
    if (!path) return;
    await api.post('/courseware/folders', { path });
    await refresh();
    folderPath.value = path;
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') throw error;
  }
}
async function move(item: CoursewareDto, target: string) {
  await api.patch(`/courseware/${item.id}/folder`, { folderPath: target });
  await refresh();
}
const filtered = computed(() =>
  items.value.filter(
    (item) =>
      (!query.value || `${item.name} ${item.teacher.name}`.includes(query.value)) &&
      (!category.value || item.category === category.value) &&
      (grouping.value !== 'folder' ||
        !folderFilter.value ||
        item.folderPath === folderFilter.value ||
        item.folderPath?.startsWith(folderFilter.value + '/')) &&
      (grouping.value !== 'date' ||
        !dateFolder.value ||
        (item.archivePath?.startsWith(dateFolder.value + '/') ?? item.archiveDate === dateFolder.value)) &&
      (!date.value || item.archiveDate === date.value),
  ),
);
function size(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
function choose(event: Event) {
  const picked = (event.target as HTMLInputElement).files?.[0];
  // 取消选择时不丢掉上一次选中的文件。
  if (picked) file.value = picked;
}
function pickFile() {
  if (!fileInput.value) return;
  // 允许重新选择同一个文件：清空后再打开选择器。
  fileInput.value.value = '';
  fileInput.value.click();
}
async function refresh() {
  loading.value = true;
  try {
    items.value = await api.get<CoursewareDto[]>('/courseware');
    if (canWrite.value)
      [classes.value, folders.value] = await Promise.all([
        api.get<CoursewareClassDto[]>('/courseware/classes'),
        api.get<CoursewareFolderDto[]>('/courseware/folders'),
      ]);
  } finally {
    loading.value = false;
  }
}
async function upload() {
  if (!file.value) return void ElMessage.warning('请选择课件文件');
  if (!file.value.size || file.value.size > COURSEWARE_MAX_BYTES)
    return void ElMessage.warning('请选择非空且不超过 512 MB 的文件');
  if (mode.value === 'push' && !classIds.value.length)
    return void ElMessage.warning('请选择需要推送的授课班级');
  const metadata: CoursewareUploadRequest = {
    name: file.value.name,
    size: file.value.size,
    classIds: [...classIds.value],
    mode: mode.value,
    folderPath: folderPath.value,
  };
  uploading.value = true;
  progress.value = 0;
  try {
    await api.post<CoursewareDto>('/courseware/upload', file.value, {
      params: { metadata: JSON.stringify(metadata) },
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: COURSEWARE_TRANSFER_TIMEOUT_MS,
      onUploadProgress: (event) => {
        progress.value = event.total ? Math.min(99, Math.round((event.loaded / event.total) * 100)) : 0;
      },
    });
    progress.value = 100;
    ElMessage.success(mode.value === 'push' ? '已归档并发送，离线班级上线后自动接收' : '课件已保存到云端');
    await refresh();
  } finally {
    uploading.value = false;
  }
}
function edit(item: CoursewareDto, operation: 'visibility' | 'push') {
  scopeItem.value = item;
  scopeMode.value = operation;
  const allowed = new Set(classes.value.map((c) => c.id));
  scopeIds.value = item.classes.filter((c) => allowed.has(c.id)).map((c) => c.id);
}
async function saveScope() {
  if (!scopeItem.value) return;
  if (scopeMode.value === 'push' && !scopeIds.value.length) return void ElMessage.warning('请选择班级');
  saving.value = true;
  try {
    if (scopeMode.value === 'push')
      await api.post(`/courseware/${scopeItem.value.id}/push`, { classIds: scopeIds.value });
    else await api.patch(`/courseware/${scopeItem.value.id}/visibility`, { classIds: scopeIds.value });
    scopeItem.value = null;
    ElMessage.success('已保存');
    await refresh();
  } finally {
    saving.value = false;
  }
}
async function download(item: CoursewareDto) {
  const blob = await api.download(`/courseware/${item.id}/download`);
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = item.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function remove(item: CoursewareDto) {
  try {
    await ElMessageBox.confirm(`删除「${item.name}」后，各班将无法继续下载。`, '删除课件', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  await api.delete(`/courseware/${item.id}`);
  await refresh();
}
onMounted(() => void refresh());
</script>
<template>
  <div class="page courseware-page">
    <header class="page-header">
      <div>
        <h2 class="page-title">课件</h2>
        <p>创建文件夹分类，或按教师、上传年份、月、日、时间浏览课件。</p>
      </div>
      <el-button :loading="loading" @click="refresh">刷新</el-button>
    </header>
    <el-card v-if="canWrite" shadow="never">
      <h3>上传课件</h3>
      <el-form label-position="top" :disabled="uploading">
        <el-form-item label="文件（最大 512 MB）">
          <div class="file-picker">
            <el-button :disabled="uploading" @click="pickFile">
              {{ file ? '重新选择文件' : '选择文件' }}
            </el-button>
            <span v-if="file" class="file-name">{{ file.name }} · {{ size(file.size) }}</span>
            <span v-else class="file-placeholder">未选择文件</span>
            <input
              ref="fileInput"
              aria-label="选择课件文件"
              type="file"
              :disabled="uploading"
              class="hidden-input"
              @change="choose"
            />
          </div>
        </el-form-item>
        <el-form-item label="分类文件夹">
          <div class="folder-picker">
            <el-select v-model="folderPath" clearable placeholder="按上传日期自动归档">
              <el-option
                v-for="folder in folders"
                :key="folder.id"
                :value="folder.path"
                :label="folder.path"
              />
            </el-select>
            <el-button @click="newFolder">新建文件夹</el-button>
          </div>
        </el-form-item>
        <el-form-item label="可见范围">
          <el-select
            v-model="classIds"
            multiple
            clearable
            placeholder="仅自己可见；也可选择授课班级"
            style="width: 100%"
          >
            <el-option v-for="c in classes" :key="c.id" :value="c.id" :label="c.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="上传方式">
          <el-radio-group v-model="mode">
            <el-radio value="cloud">仅保存云端</el-radio>
            <el-radio value="push">保存后推送所选班级</el-radio>
          </el-radio-group>
        </el-form-item>
        <p class="hint">
          未选择班级时仅自己可见。仅保存云端的课件由可见班级自主下载；推送会在班级端自动下载，先存云端再发送。
        </p>
        <el-button type="primary" :loading="uploading" :disabled="!file" @click="upload">
          {{ mode === 'push' ? '上传并推送' : '上传云端' }}
        </el-button>
        <el-progress
          v-if="uploading || progress === 100"
          :percentage="progress"
          :status="progress === 100 ? 'success' : undefined"
        />
        <p v-if="uploading && progress === 99" class="hint">正在等待服务端校验与归档…</p>
      </el-form>
    </el-card>
    <el-card shadow="never" class="table-card" v-loading="loading">
      <div class="filters">
        <el-radio-group v-model="grouping">
          <el-radio-button value="date">日期归档</el-radio-button>
          <el-radio-button value="folder">文件夹分类</el-radio-button>
        </el-radio-group>
        <el-select v-if="grouping === 'folder'" v-model="folderFilter" clearable placeholder="全部文件夹">
          <el-option v-for="folder in folders" :key="folder.id" :value="folder.path" :label="folder.path" />
        </el-select>
        <el-select v-else v-model="dateFolder" filterable clearable placeholder="教师 / 年 / 月 / 日 / 时间">
          <el-option v-for="folder in dateFolders" :key="folder" :value="folder" :label="folder" />
        </el-select>
        <el-input v-model="query" clearable placeholder="搜索文件名、教师" />
        <el-select v-model="category" clearable placeholder="全部类型">
          <el-option v-for="(label, key) in COURSEWARE_CATEGORIES" :key="key" :label="label" :value="key" />
        </el-select>
        <el-date-picker v-model="date" value-format="YYYY-MM-DD" placeholder="归档日期" />
      </div>
      <el-table :data="filtered" empty-text="暂无课件">
        <el-table-column prop="name" label="文件名称" min-width="220" show-overflow-tooltip />
        <el-table-column label="分类 / 归档位置" min-width="230">
          <template #default="{ row }">
            <el-select
              v-if="canWrite && row.teacher.id === auth.user?.id"
              :model-value="row.folderPath || ''"
              clearable
              size="small"
              placeholder="自动日期归档"
              @change="move(row, $event || '')"
            >
              <el-option
                v-for="folder in folders"
                :key="folder.id"
                :value="folder.path"
                :label="folder.path"
              />
            </el-select>
            <small class="archive-path">{{ row.archivePath }}</small>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="110">
          <template #default="{ row }">
            {{ COURSEWARE_CATEGORIES[(row as CoursewareDto).category] }} · {{ row.extension || '无扩展名' }}
          </template>
        </el-table-column>
        <el-table-column label="大小" width="100">
          <template #default="{ row }">{{ size(row.size) }}</template>
        </el-table-column>
        <el-table-column prop="archiveDate" label="归档日期" width="120" />
        <el-table-column prop="teacher.name" label="上传教师" width="110" />
        <el-table-column label="可见范围" min-width="160">
          <template #default="{ row }">
            {{ (row as CoursewareDto).classes.map((c) => c.name).join('、') || '仅自己' }}
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="260">
          <template #default="{ row }">
            <el-button link type="primary" @click="download(row)">下载</el-button>
            <template v-if="canWrite && row.teacher.id === auth.user?.id">
              <el-button link type="primary" @click="edit(row, 'visibility')">可见范围</el-button>
              <el-button link type="primary" @click="edit(row, 'push')">推送</el-button>
              <el-button link type="danger" @click="remove(row)">删除</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
    <el-dialog
      :model-value="!!scopeItem"
      :title="scopeMode === 'push' ? '推送课件' : '设置可见范围'"
      :width="isMobile ? '94%' : '500px'"
      @close="scopeItem = null"
    >
      <p>{{ scopeItem?.name }}</p>
      <el-select v-model="scopeIds" multiple clearable style="width: 100%" placeholder="请选择自己的授课班级">
        <el-option
          v-for="c in classes.filter(
            (c) => scopeMode !== 'push' || scopeItem?.classes.some((v) => v.id === c.id),
          )"
          :key="c.id"
          :label="c.name"
          :value="c.id"
        />
      </el-select>
      <p class="hint">
        {{
          scopeMode === 'push'
            ? '仅向可见范围中的所选班级发送；离线时等待上线。'
            : '留空表示仅自己可见；移除班级会取消该班尚未完成的传输。已下载的本地文件需由班级自行删除。'
        }}
      </p>
      <template #footer>
        <el-button @click="scopeItem = null">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveScope">
          {{ scopeMode === 'push' ? '发送课件' : '保存' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
<style scoped>
.courseware-page {
  display: grid;
  gap: 20px;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
h2,
h3 {
  margin-top: 0;
}
p,
.hint {
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}
.filters {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}
.filters > * {
  flex: 1;
  min-width: 160px;
}
.el-progress {
  margin-top: 16px;
}
.folder-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  width: 100%;
}
.folder-picker .el-select {
  flex: 1 1 220px;
}
.archive-path {
  display: block;
  overflow-wrap: anywhere;
  color: var(--el-text-color-secondary);
  margin-top: 6px;
}
.file-picker {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}
.file-name,
.file-placeholder {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--el-text-color-regular);
}
.file-placeholder {
  color: var(--el-text-color-secondary);
}
.hidden-input {
  display: none;
}
</style>
