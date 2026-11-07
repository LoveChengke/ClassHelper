/** 时间点按钮的真实处理函数回归：模拟 HTTP 内网缺少 randomUUID 的浏览器。 */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(
  path.join(__dirname, '../packages/web-admin/src/components/TimeLayoutEditor.vue'),
  'utf8',
);
const script = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile('editor.ts', script, ts.ScriptTarget.Latest, true);
const withoutImports = parsed.statements
  .filter((node) => !ts.isImportDeclaration(node))
  .map((node) => node.getText(parsed))
  .join('\n');

for (const secure of [false, true]) {
  const layout = { value: { points: [] } };
  const context = {
    crypto: secure ? require('node:crypto').webcrypto : {},
    defineProps: () => ({ canEdit: true, layouts: [], courses: [] }),
    defineModel: () => layout,
    defineEmits: () => () => {},
    ref: (value) => ({ value }),
    computed: (fn) => ({
      get value() {
        return fn();
      },
    }),
    watch: () => {},
    onMounted: () => {},
    onUnmounted: () => {},
    nextTick: async () => {},
    ElMessage: {
      warning: (message) => {
        throw new Error(message);
      },
    },
    TIME_POINT_TYPES: [],
  };
  vm.runInNewContext(
    ts.transpile(
      `${withoutImports}\nfor (const type of ['LESSON', 'BREAK', 'DIVIDER', 'ACTION']) addPoint(type);`,
    ),
    context,
  );
  assert.equal(layout.value.points.length, 4, '四种按钮均应新增时间点');
  assert.equal(new Set(layout.value.points.map((point) => point.id)).size, 4, '草稿 id 不可重复');
  assert.equal(layout.value.points[0].startTime, '08:00');
  assert.equal(layout.value.points[0].endTime, '08:40');
  console.log(`[PASS] ${secure ? 'HTTPS' : 'HTTP 内网'}：四种时间点可添加，草稿 id 唯一`);
}
