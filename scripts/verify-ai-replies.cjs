/** 真实模型回复解析器的快速回归；不加载业务库，不访问模型服务。 */
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { createRequire } = require('node:module');
const requireServer = createRequire(path.resolve(__dirname, '../packages/server/package.json'));
const output = {};
const source = fs.readFileSync(
  path.resolve(__dirname, '../packages/server/src/modules/ai/model-reply.ts'),
  'utf8',
);
vm.runInNewContext(
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  { exports: output, require: requireServer },
);
const parse = output.parseModelReply;
for (const sample of [
  '请确认是否删除“周一课表”？确认后我会继续。',
  JSON.stringify({ message: '请确认是否删除“周一课表”？', queries: [], operations: [] }),
  JSON.stringify({ questions: [{ question: '要删除哪张课表？', options: ['周一', '周五'] }] }),
  JSON.stringify({ question: '请选择要删除的课表。' }),
  JSON.stringify({ questions: ['请选择要删除的课表。'] }),
  JSON.stringify({
    questions: [{ text: '请选择课表', options: [{ label: '周一', description: '每周一' }] }],
  }),
  JSON.stringify('Would you like to continue?'),
]) {
  const reply = parse(sample);
  assert(reply.questions.length > 0);
  assert.equal(reply.operations.length, 0);
  assert.equal(reply.queries.length, 0);
}
assert(parse('请确认是否删除课表？').questions[0].options.includes('继续生成操作预览'));
const deletion = {
  message: '请确认删除',
  operations: [{ action: 'plans.delete', target: { id: 'existing-plan' } }],
};
const plan = parse(JSON.stringify(deletion));
assert.equal(plan.operations[0].target.id, 'existing-plan');
assert(!plan.questions?.length);
const mixed = parse(JSON.stringify({ ...deletion, questions: [{ text: '请选择课表' }] }));
assert.equal(mixed.operations.length, 0);
for (const sample of [
  '空白',
  '已删除课表。',
  '{"message":"确认删除吗？"',
  '{"operations":[{"action":"plans.delete","target":{"id":10}}]}',
  '{"operations":{}}',
])
  assert.throws(() => parse(sample));
console.log('PASS：追问兼容、删除预览保留、问题优先及损坏协议拒绝');
