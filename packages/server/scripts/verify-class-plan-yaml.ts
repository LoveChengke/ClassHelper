/** 纯解析回归，不访问业务库。用 node --import tsx scripts/verify-class-plan-yaml.ts 执行。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLASS_PLAN_YAML_SAMPLE } from '@classhelper/shared';
import {
  buildClassIslandProfile,
  parseClassPlanYaml,
} from '../src/modules/imports/class-plan-yaml.service.js';

const example = readFileSync(new URL('../../../yml导入格式示例.yml', import.meta.url), 'utf8');
const parsed = parseClassPlanYaml(example);
assert.deepEqual(parsed.errors, []);
assert.equal(parsed.entries.length, 6);
assert.equal(parsed.planCount, 3);
assert.deepEqual(
  parsed.entries.map((entry) => entry.weekParity),
  ['ALL', 'ALL', 'ODD', 'ODD', 'EVEN', 'EVEN'],
);
assert.equal(parsed.entries[0]?.startTime, '08:00');
assert.equal(parsed.entries[0]?.location, '101');
assert.equal(parsed.subjects[0]?.initial, '数');
const profile = buildClassIslandProfile(parsed, 30);
assert.equal(Object.keys(profile.ClassPlans as object).length, 3);
assert.equal(Object.keys(profile.TimeLayouts as object).length, 1);
console.log('[PASS] 用户示例：省略冒号、HHMMSS、简称、教室及单双周');

assert.deepEqual(parseClassPlanYaml(CLASS_PLAN_YAML_SAMPLE).errors, []);
const standard = `version: 1
subjects:
  - name: 数学
schedules:
  - name: 周日
    enable_day: 7
    weeks: all
    classes:
      - subject: 数学
        start_time: 080000
        end_time: '090000'
`;
assert.deepEqual(parseClassPlanYaml(standard).errors, []);
assert.equal(parseClassPlanYaml(standard).entries[0]?.dayOfWeek, 7);
assert.deepEqual(
  parseClassPlanYaml(standard.replace('080000', "'08:00'").replace('090000', '09:00:00')).errors,
  [],
);
console.log('[PASS] 标准 YAML：六位数字/字符串、冒号时间、周日映射');

for (const [name, invalid] of [
  ['空文件', ''],
  ['不支持的版本', standard.replace('version: 1', 'version: 2')],
  ['小数星期', standard.replace('enable_day: 7', 'enable_day: 1.5')],
  ['非法小时', standard.replace('080000', '250000')],
  ['非法分钟', standard.replace('080000', '086000')],
  ['非零秒', standard.replace('080000', '080001')],
  ['反向时间', standard.replace('090000', '070000')],
  ['未知单双周', standard.replace('weeks: all', 'weeks: unknown')],
  ['重复字段', standard.replace('version: 1', 'version: 1\nversion: 1')],
  ['同日相位冲突', standard + standard.slice(standard.indexOf('  - name: 周日'))],
] as const) {
  assert.ok(parseClassPlanYaml(invalid).errors.length > 0, name);
}
console.log('[PASS] 错误输入被拒绝，避免部分导入或丢失时间精度');
