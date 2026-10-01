#!/usr/bin/env node
/**
 * 构建产物凭据自检：`dist` 里不允许出现种子账号 / 口令字面量。
 *
 * 为什么单独立一条门禁：`dist/main/index.js` 与 `dist/renderer/assets/*.js` 会被 electron-builder
 * 打进 `app.asar`，随安装包发到每台学生机，而 **asar 可以直接解包**。
 * 冒烟/自检代码里写死 `teacher1 / teacher123` 这类字面量，等于把教师账号随安装包一起发出去
 * （历史上真的发生过：`grep teacher123 dist/main/index.js` 命中 3 次）。
 *
 * 凭据一律由 `scripts/smoke.mjs` / `scripts/verify-packaged.mjs` 通过环境变量提供
 * （`ELECTRON_SMOKE_USER` / `ELECTRON_SMOKE_PASSWORD` / `ELECTRON_SMOKE_CLASS_CODE` / `..._CLASS_PASSWORD`），
 * 那两个脚本不进安装包。
 *
 * 命中即构建失败（exit 1）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');

/** 明确的种子口令：任何情况下都不该出现在产物里 */
const FORBIDDEN_STRINGS = ['teacher123', 'admin123', 'student123'];

/** 组合形态：把种子班级码 / 默认班级密码当凭据使用的写法 */
const FORBIDDEN_PATTERNS = [
  { label: '种子班级码当凭据', pattern: /["'](?:code|classCode)["']\s*[:=]\s*["']G(?:101|102|203)["']/ },
  {
    label: '默认班级密码当凭据',
    pattern: /["'](?:password|classPassword)["']\s*[:=]\s*["']123456["']/,
  },
];

/** 递归收集文件（跳过 sourcemap 与二进制） */
function collectFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectFiles(full));
    } else if (/\.(?:js|mjs|cjs|html|json|css)$/i.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

if (!fs.existsSync(distDir)) {
  console.log('[check-secrets] 未找到 dist（尚未构建），跳过凭据自检');
  process.exit(0);
}

const hits = [];
for (const file of collectFiles(distDir)) {
  const content = fs.readFileSync(file, 'utf8');
  const relative = path.relative(root, file);
  for (const needle of FORBIDDEN_STRINGS) {
    if (content.includes(needle)) hits.push(`${relative}：出现种子口令「${needle}」`);
  }
  for (const { label, pattern } of FORBIDDEN_PATTERNS) {
    if (pattern.test(content)) hits.push(`${relative}：${label}`);
  }
}

if (hits.length > 0) {
  console.error('[check-secrets] 构建产物里出现了种子凭据（asar 可被解包，不能随包分发）：');
  for (const hit of hits) console.error(`  - ${hit}`);
  console.error(
    '\n请把凭据改为从环境变量读取（见 scripts/smoke.mjs 的 ELECTRON_SMOKE_USER 等），不要写进源码。',
  );
  process.exit(1);
}

console.log(`[check-secrets] 通过：${collectFiles(distDir).length} 个产物文件里没有任何种子凭据字面量`);
