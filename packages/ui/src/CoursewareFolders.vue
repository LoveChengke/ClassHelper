<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{
  items: { folderPath?: string; teacher: { id: string; name: string } }[];
  folders?: { path: string }[];
  owner?: string;
  path: string;
}>();
const emit = defineEmits<{ 'update:path': [value: string]; 'update:owner': [value: string] }>();
const teachers = computed(() => [...new Map(props.items.map((i) => [i.teacher.id, i.teacher])).values()]);
const children = computed(() => {
  const paths = [
    ...props.items.filter((i) => !props.owner || i.teacher.id === props.owner).map((i) => i.folderPath || ''),
    ...(props.folders || []).map((f) => f.path),
  ];
  if (teachers.value.length > 1 && !props.owner) return [];
  const prefix = props.path ? props.path + '/' : '';
  return [
    ...new Set(
      paths
        .filter((p) => p.startsWith(prefix) && p !== props.path)
        .map((p) => p.slice(prefix.length).split('/')[0])
        .filter(Boolean),
    ),
  ].sort();
});
</script>
<template>
  <div class="courseware-folders">
    <label v-if="teachers.length > 1">
      教师
      <select
        :value="owner"
        @change="
          emit('update:owner', ($event.target as HTMLSelectElement).value);
          emit('update:path', '');
        "
      >
        <option value="">选择教师</option>
        <option v-for="t in teachers" :key="t.id" :value="t.id">{{ t.name }}</option>
      </select>
    </label>
    <nav aria-label="文件夹路径">
      <button @click="emit('update:path', '')">根目录</button>
      <template v-for="(part, index) in path.split('/').filter(Boolean)" :key="index">
        <span>/</span>
        <button
          @click="
            emit(
              'update:path',
              path
                .split('/')
                .slice(0, index + 1)
                .join('/'),
            )
          "
        >
          {{ part }}
        </button>
      </template>
    </nav>
    <button v-if="path" @click="emit('update:path', path.split('/').slice(0, -1).join('/'))">返回上级</button>
    <div class="folder-children">
      <button
        v-for="name in children"
        :key="name"
        @click="emit('update:path', path ? path + '/' + name : name)"
      >
        📁 {{ name }}
      </button>
    </div>
  </div>
</template>
<style scoped>
.courseware-folders {
  display: grid;
  gap: 12px;
  padding: 12px 0;
}
.courseware-folders nav,
.folder-children {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.courseware-folders button,
.courseware-folders select {
  padding: 8px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  max-width: 100%;
  overflow-wrap: anywhere;
  cursor: pointer;
}
</style>
