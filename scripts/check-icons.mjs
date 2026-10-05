#!/usr/bin/env node
/**
 * 图标注册表静态校验（构建前门禁）。
 *
 * 为什么需要：
 * 本项目的 Element Plus 图标是按**字符串名**全局引用的 —— 菜单/路由配置里的 `icon: 'Odometer'`、
 * 按钮上的 `:icon="'Search'"`、`<component :is="item.icon">`，以及模板里的 `<el-icon><School /></el-icon>`。
 * 为了让主 chunk 不为 293 个图标里的 250 个死代码买单，两端改成**按需注册**
 * （`packages/web-admin/src/icons.ts`、`packages/desktop-client/src/renderer/icons.ts`）。
 *
 * 代价是：新增视图时用了一个没注册的图标，Vue 只会打一条 warning、界面上**静默渲染成空白** ——
 * 这类问题在 verify:web / verify:desktop 里都不容易暴露。因此在这里做一次静态校验，
 * 有遗漏就 exit 1，把失败挪到构建阶段。
 *
 * 用法：node scripts/check-icons.mjs   （已挂进两端 package.json 的 build 脚本）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  {
    name: 'web-admin',
    registry: path.join(root, 'packages/web-admin/src/icons.ts'),
    sources: [path.join(root, 'packages/web-admin/src')],
  },
  {
    name: 'desktop-client',
    registry: path.join(root, 'packages/desktop-client/src/renderer/icons.ts'),
    sources: [
      path.join(root, 'packages/desktop-client/src/renderer'),
      path.join(root, 'packages/desktop-client/src/island'),
    ],
  },
];

/** 递归收集 .vue / .ts 源文件 */
function collectFiles(dirs) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(vue|ts)$/.test(entry.name)) found.push(full);
    }
  };
  for (const dir of dirs) {
    if (fs.existsSync(dir)) walk(dir);
  }
  return found;
}

/**
 * 从注册表文件里取出 `const APP_ICONS = { ... } as const;` 的键名。
 * 这里刻意做文本解析而不是 import：注册表是 .ts，构建期没有可用的 TS 运行时。
 * 对象字面量用的是简写属性（`{ Odometer, Bell }`），所以键名就是标识符本身。
 */
function readRegistry(file) {
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/const APP_ICONS = \{([\s\S]*?)\} as const;/);
  if (!match) {
    throw new Error(`${path.relative(root, file)} 里找不到 \`const APP_ICONS = { ... } as const;\` 块`);
  }
  return new Set(match[1].match(/[A-Za-z][A-Za-z0-9]*/g) ?? []);
}

/**
 * Element Plus 图标库的真实导出名（293 个）。
 * 用运行时 import 取，而不是从 `dist/types/components/*.vue.d.ts` 猜文件名转 PascalCase ——
 * 后者的来回转换（如 `circle-check-filled`）并不可靠。
 */
async function loadKnownIconNames() {
  const candidates = [
    path.join(root, 'packages/web-admin/node_modules/@element-plus/icons-vue'),
    path.join(root, 'packages/desktop-client/node_modules/@element-plus/icons-vue'),
  ];
  for (const base of candidates) {
    const manifest = path.join(base, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const entry = path.resolve(base, pkg.module ?? pkg.main);
    const module = await import(pathToFileURL(entry).href);
    return new Set(Object.keys(module).filter((key) => key !== 'default' && /^[A-Z][A-Za-z0-9]*$/.test(key)));
  }
  throw new Error('找不到 @element-plus/icons-vue，请先执行 pnpm install');
}

/** 扫描一个包，返回「用到的图标名 -> 首次出现位置」 */
function collectUsages(files, known) {
  const usages = new Map();
  const record = (name, file, index) => {
    if (!known.has(name) || usages.has(name)) return;
    const line = fs.readFileSync(file, 'utf8').slice(0, index).split('\n').length;
    usages.set(name, `${path.relative(root, file)}:${line}`);
  };

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    // 字符串形式：icon: 'Odometer' / :icon="'Search'" / :prefix-icon="'Lock'" / 菜单配置数组
    for (const match of source.matchAll(/['"]([A-Z][A-Za-z0-9]*)['"]/g)) {
      record(match[1], file, match.index ?? 0);
    }
    // 标签形式：<el-icon><School /></el-icon> / <Loading />
    for (const match of source.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) {
      record(match[1], file, match.index ?? 0);
    }
  }
  return usages;
}

const known = await loadKnownIconNames();
let failed = false;

for (const target of TARGETS) {
  const registered = readRegistry(target.registry);
  // 扫描时排除注册表自身：否则报出的「首次出现位置」会是注册表那一行，指不到真正的使用点
  const files = collectFiles(target.sources).filter((file) => file !== target.registry);
  const usages = collectUsages(files, known);

  const missing = [...usages.keys()].filter((name) => !registered.has(name)).sort();
  const unused = [...registered].filter((name) => !usages.has(name)).sort();

  if (missing.length > 0) {
    failed = true;
    console.error(`\n[check-icons] ✗ ${target.name}：以下图标被使用但未注册（界面会渲染成空白）`);
    for (const name of missing) {
      console.error(`  - ${name}  （${usages.get(name)}）`);
    }
    console.error(`  请把它们加进 ${path.relative(root, target.registry)} 的 APP_ICONS 对象与 import 列表。`);
  } else {
    console.log(`[check-icons] ✓ ${target.name}：用到 ${usages.size} 个图标，全部已注册`);
  }

  if (unused.length > 0) {
    // 不是错误：多注册一个只多 1KB 左右。列出来是为了让名单别无限膨胀。
    console.log(`[check-icons]   提示：注册了但当前未使用的图标 —— ${unused.join('、')}`);
  }
}

if (failed) process.exit(1);
console.log('[check-icons] 图标注册表校验通过');
