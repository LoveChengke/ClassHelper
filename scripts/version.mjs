#!/usr/bin/env node
/**
 * 版本号的读写与一致性校验 —— `pnpm version:check` / `pnpm version:bump <级别>`。
 *
 * ## 为什么要这个脚本
 *
 * 这个仓库里**同一个版本号写在 13 处（11 个文件）**：5 份 package.json、运行时常量、两个 compose 文件、
 * 插件清单、插件 C# 源码里的一个 const，以及官网页面上三处手写的版本号。手工改必然漏一处，
 * 而漏掉的那处**不会报错**，只会在某个不常走的分支上表现为"版本号对不上"：
 *
 *   - `deploy/docker-compose*.yml`     镜像 tag 落后 → 服务器上跑的还是旧镜像；
 *   - `deploy/package.runtime.json`    容器 / 安装包里那份依赖清单的版本（人看，但会误导排查）；
 *   - `manifest.yml` + `BridgeService.cs`  ClassIsland 上显示的插件版本
 *     （清单里的 version 与实际上报的 PluginVersion 不一致时，
 *     Web 端「ClassIsland 联动」页显示的版本会对不上插件市场）；
 *   - `website/index.html` 的那三处        官网是纯静态站、无构建步骤，没有哪段代码会去读
 *     `package.json`，漏改的后果是**首页上一直挂着旧版本号** —— 那是别人看到的第一眼。
 *
 * 因此：**改版本号的唯一入口是这个脚本**。它按表逐个改写，任何一处没匹配到（或匹配到多处）
 * 就直接失败退出，不做"尽力而为"的部分改写。
 *
 * ## 用法
 *
 *   node scripts/version.mjs                    # 检查（默认）：列出各处版本，不一致则 exit 1
 *   node scripts/version.mjs --bump patch       # 1.1.2 → 1.1.3
 *   node scripts/version.mjs --bump minor       # 1.1.2 → 1.2.0
 *   node scripts/version.mjs --bump major       # 1.1.2 → 2.0.0
 *   node scripts/version.mjs --set 1.2.0        # 显式指定（插件同时设为 1.2.0.0）
 *   node scripts/version.mjs --bump minor --dry # 只看会改哪些文件，不落盘
 *
 * 版本口径与完整发布流程见 docs/dev/release.md。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `pattern` 一律写成**三个捕获组**：`(前缀)(版本号)(后缀)`。
 * 前缀与后缀原样保留，中间的版本号被替换 —— 这样既能精确替换，也能取出来比对。
 */
const PRODUCT_TARGETS = [
  { file: 'package.json', pattern: /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/ },
  { file: 'packages/shared/package.json', pattern: /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/ },
  { file: 'packages/server/package.json', pattern: /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/ },
  { file: 'packages/web-admin/package.json', pattern: /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/ },
  { file: 'packages/desktop-client/package.json', pattern: /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/ },
  { file: 'deploy/package.runtime.json', pattern: /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/ },
  {
    file: 'deploy/docker-compose.yml',
    pattern: /(classhelper-server:\$\{APP_VERSION:-)(\d+\.\d+\.\d+)(\})/,
  },
  {
    file: 'deploy/docker-compose.sqlite.yml',
    pattern: /(classhelper-server:\$\{APP_VERSION:-)(\d+\.\d+\.\d+)(\})/,
  },
];

/**
 * 插件版本（`x.y.z.0`）。第 4 段留给"只改插件、不动产品版本"的补丁发布；
 * `--bump` / `--set` 一律把它归零，要单独发插件补丁时手工改这两处即可。
 */
const PLUGIN_TARGETS = [
  {
    file: 'packages/classisland-plugin/manifest.yml',
    pattern: /^(version:[ \t]*)(\d+\.\d+\.\d+\.\d+)([ \t]*)$/m,
  },
  {
    file: 'packages/classisland-plugin/src/Services/BridgeService.cs',
    pattern: /(private const string PluginVersion = ")(\d+\.\d+\.\d+\.\d+)(";)/,
  },
];

/**
 * 官网首屏与页脚那三处手写的版本号。官网是纯静态站，没有构建步骤、也没有哪段代码会去读
 * `package.json`，所以这三处只能靠脚本一起改 —— 漏了的话官网会一直显示旧版本号，
 * 而它是别人看到的第一眼。
 */
const SITE_TARGETS = [
  {
    file: 'website/index.html',
    label: '（顶栏徽标）',
    pattern: /(<span class="brand-ver">)(\d+\.\d+\.\d+)(<\/span>)/,
  },
  { file: 'website/index.html', label: '（首屏芯片）', pattern: /(<li>v)(\d+\.\d+\.\d+)(<\/li>)/ },
  {
    file: 'website/index.html',
    label: '（页脚）',
    pattern: /(<p class="foot-ver">版本 )(\d+\.\d+\.\d+)( ·)/,
  },
];

const ALL_TARGETS = [...PRODUCT_TARGETS, ...PLUGIN_TARGETS, ...SITE_TARGETS];

const PRODUCT_RE = /^\d+\.\d+\.\d+$/;
const PLUGIN_RE = /^\d+\.\d+\.\d+\.\d+$/;

/** 输出用的名字：同一个文件里有多个落点时带上括号里的说明，否则三行看起来一模一样 */
function name(target) {
  return target.label ? `${target.file} ${target.label}` : target.file;
}

function readTarget(target) {
  const source = fs.readFileSync(path.join(root, target.file), 'utf8');
  const flags = target.pattern.flags.includes('g') ? target.pattern.flags : `${target.pattern.flags}g`;
  const hits = [...source.matchAll(new RegExp(target.pattern.source, flags))];
  return { source, hits, global: new RegExp(target.pattern.source, flags) };
}

/** 取出某个文件当前声明的版本号；没匹配到或匹配到多处都返回 null。 */
function readVersion(target) {
  const { hits } = readTarget(target);
  return hits.length === 1 ? hits[0][2] : null;
}

/** 改写一处。缺失或重复命中都算失败 —— 静默漏改比直接报错危险得多。 */
function writeVersion(target, next, { dry }) {
  const { source, hits, global } = readTarget(target);
  if (hits.length !== 1) {
    throw new Error(
      `${target.file} 里匹配到 ${hits.length} 处版本号（应为 1 处）。` +
        ' 模板被改过？请同步 scripts/version.mjs 里的 pattern 表。',
    );
  }
  if (!dry) {
    const replaced = source.replace(global, (_m, prefix, _old, suffix) => `${prefix}${next}${suffix}`);
    fs.writeFileSync(path.join(root, target.file), replaced, 'utf8');
  }
  return `${name(target)}  ${hits[0][2]} → ${next}`;
}

function bumpProduct(current, level) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  if (level === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`未知的级别 ${level}（可选：major / minor / patch，或用 --set x.y.z）`);
}

/** 检查模式：逐处列出，并给出不一致清单。 */
function check(product) {
  console.log(`产品版本（单一来源：根 package.json）：${product}\n`);
  const width = Math.max(...ALL_TARGETS.map((target) => target.file.length));
  const problems = [];

  for (const target of ALL_TARGETS) {
    const version = readVersion(target);
    if (!version) {
      console.log(`?? ${name(target).padEnd(width)}  （未匹配到版本号）`);
      problems.push(`${target.file}：匹配不到版本号`);
      continue;
    }
    // 插件版本是四段，只校验前三段；第 4 段允许不为 0（插件专属补丁号）
    const expected = PLUGIN_RE.test(version) ? `${product}.0` : product;
    const ok = PLUGIN_RE.test(version)
      ? version.split('.').slice(0, 3).join('.') === product
      : version === expected;
    console.log(`${ok ? '  ' : '!!'} ${name(target).padEnd(width)}  ${version}`);
    if (!ok) problems.push(`${target.file}：${version} ≠ ${expected}`);
  }

  if (problems.length) {
    console.error('\n版本号不一致：');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('\n对齐方式：pnpm version:check 之后用 pnpm version:bump patch 统一改写。');
    process.exit(1);
  }
  console.log('\n全部一致 ✅（插件第 4 段是插件专属补丁号，允许不为 0）');
}

function apply(next, { dry, product }) {
  const pluginNext = `${next}.0`;
  const lines = [];
  for (const target of PRODUCT_TARGETS) lines.push(writeVersion(target, next, { dry }));
  for (const target of PLUGIN_TARGETS) lines.push(writeVersion(target, pluginNext, { dry }));
  for (const target of SITE_TARGETS) lines.push(writeVersion(target, next, { dry }));

  console.log(
    `${dry ? '[dry] 将改写' : '已改写'} ${product} → ${next}（插件 ${product}.0 → ${pluginNext}）：\n`,
  );
  for (const line of lines) console.log(`  ${line}`);
  console.log('\n接着按 docs/dev/release.md 走发布流程；GitHub Release 的 tag（v' + next + '）也要对齐。');
}

function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const bumpIndex = args.indexOf('--bump');
  const setIndex = args.indexOf('--set');

  const product = readVersion(PRODUCT_TARGETS[0]); // 根 package.json = 单一来源
  if (!product || !PRODUCT_RE.test(product)) {
    throw new Error('读不到根 package.json 的版本号（或它不是 x.y.z 形式）');
  }

  let next = null;
  if (bumpIndex >= 0) {
    const level = args[bumpIndex + 1];
    if (!level) throw new Error('--bump 后面要跟 patch / minor / major');
    next = bumpProduct(product, level);
  } else if (setIndex >= 0) {
    const value = args[setIndex + 1];
    if (!value) throw new Error('--set 后面要跟 x.y.z');
    if (!PRODUCT_RE.test(value)) throw new Error(`--set 的取值 ${value} 不是 x.y.z 形式`);
    next = value;
  }

  if (!next) check(product);
  else apply(next, { dry, product });
}

try {
  main();
} catch (error) {
  console.error(`[version] ${error.message}`);
  process.exit(1);
}
