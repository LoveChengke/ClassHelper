<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { formatDate, type UpdateInfo } from '@classhelper/shared';
import { updateApi } from '@/api';

/**
 * 「检查更新」弹窗（Web 管理端顶栏用户菜单）。
 *
 * 数据来自**服务端**的 `GET /api/update/check` —— 浏览器受服务端下发的 CSP `connect-src`
 * 限制，不能直连 `api.github.com`；走服务端转发还顺带让所有管理员共享同一份缓存
 * （GitHub 匿名限流 60 次/小时/IP）。
 *
 * `ok:false` 是**正常结果**（机房没有外网 / GitHub 限流 / 超时），不是错误 ——
 * 界面按"暂时查不到"呈现，并给出重试入口，而不是弹一句红字报错。
 */
const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (event: 'update:modelValue', value: boolean): void }>();

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

const loading = ref(false);
const info = ref<UpdateInfo | null>(null);

/** 发布时间（本地格式），拿不到就不显示 */
const publishedText = computed(() => {
  const at = info.value?.publishedAt;
  return at ? formatDate(at, true) : '';
});

/**
 * 用户点菜单里的「检查更新」是一次明确的手动检查，因此**绕过服务端缓存**（force=1，仅管理员生效）；
 * 打开弹窗时才查，而不是进页面就查 —— 没点菜单就不该产生任何外部请求。
 */
async function check(): Promise<void> {
  loading.value = true;
  try {
    info.value = await updateApi.check(true);
  } catch {
    // 请求本身失败（如火并发的接口限流）：http.ts 已经弹过提示，这里只保证弹窗里不留空白
    info.value = null;
  } finally {
    loading.value = false;
  }
}

function openRelease(): void {
  const url = info.value?.releaseUrl;
  if (!url) return;
  window.open(url, '_blank', 'noopener');
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '';
  const mb = size / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(size / 1024)} KB`;
}

// 打开时才查：关闭后清空结果，下次打开重新查一遍（避免显示上一次的陈旧结论）
watch(
  () => props.modelValue,
  (opened) => {
    if (opened) void check();
    else info.value = null;
  },
);
</script>

<template>
  <el-dialog v-model="visible" title="检查更新" width="520px" data-test="update-dialog">
    <div v-loading="loading" class="update-body">
      <template v-if="info && info.ok">
        <el-alert
          v-if="info.hasUpdate"
          type="success"
          :closable="false"
          show-icon
          data-test="update-found"
          :title="`发现新版本 v${info.latestVersion}`"
          :description="`当前版本 v${info.currentVersion}${publishedText ? ` · 发布于 ${publishedText}` : ''}`"
        />
        <el-alert
          v-else
          type="info"
          :closable="false"
          show-icon
          data-test="update-latest"
          title="已是最新版本"
          :description="`当前版本 v${info.currentVersion}（GitHub 最新为 v${info.latestVersion}）`"
        />

        <template v-if="info.hasUpdate">
          <div v-if="info.releaseName" class="update-name">{{ info.releaseName }}</div>

          <div v-if="info.notes" class="update-notes-label">更新说明</div>
          <pre v-if="info.notes" class="update-notes">{{ info.notes }}</pre>

          <template v-if="info.assets.length > 0">
            <div class="update-notes-label">可下载文件</div>
            <ul class="update-assets">
              <li v-for="asset in info.assets" :key="asset.name">
                <span class="update-asset-name">{{ asset.name }}</span>
                <span v-if="formatBytes(asset.size)" class="update-asset-size">
                  {{ formatBytes(asset.size) }}
                </span>
              </li>
            </ul>
          </template>
        </template>
      </template>

      <!-- 查不到不是错误：机房没有外网、GitHub 限流都会走到这里 -->
      <el-alert
        v-else-if="!loading"
        type="warning"
        :closable="false"
        show-icon
        data-test="update-unavailable"
        title="暂时无法检查更新"
        :description="info?.error ?? '请稍后重试；若服务器没有外网，可手动打开项目 Release 页面查看'"
      />
    </div>

    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
      <el-button :loading="loading" @click="check()">重新检查</el-button>
      <el-button v-if="info?.ok && info.hasUpdate" type="primary" @click="openRelease">前往下载</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.update-body {
  min-height: 72px;
}

.update-name {
  margin-top: 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.update-notes-label {
  margin: 12px 0 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.update-notes {
  margin: 0;
  padding: 10px 12px;
  max-height: 200px;
  overflow: auto;
  background: var(--el-fill-color-light);
  border-radius: var(--ch-radius-sm);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  color: var(--el-text-color-regular);
}

.update-assets {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.9;
  color: var(--el-text-color-regular);
}

.update-asset-size {
  margin-left: 6px;
  color: var(--el-text-color-secondary);
}
</style>
