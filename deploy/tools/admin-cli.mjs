#!/usr/bin/env node
/**
 * ClassHelper · 离线账号工具（随 Linux 包发布，安装在 ${INSTALL_DIR}/tools/admin-cli.mjs）
 *
 * 为什么不用 HTTP API 改密码：`classhelper password` 要能在**服务停机**时救急，
 * 而调 API 必须先有一个能登录的账号 —— 管理员忘了密码时就是死锁。
 * 因此这里直连数据库，复用服务端自己的 Prisma Client 与 bcrypt 参数（`server/dist/lib/*`），
 * 保证写入的哈希与登录校验用的是同一套实现。
 *
 * 安全约定（务必保持）：
 *   - **密码只从 stdin 读**，绝不接受 argv / 环境变量形式的密码（否则会进 shell history 与 ps 输出）；
 *   - 本工具自己**不打印任何密码**，也不写任何日志；
 *   - `dump-hash` 会输出 bcrypt 哈希 —— 仅由 root 调用的 `classhelper password` 用于改前备份，
 *     调用方负责把结果落到 600 权限的文件里。
 *
 * 用法（全部由 classhelper 封装，一般不需要手工调）：
 *   node tools/admin-cli.mjs info
 *   node tools/admin-cli.mjs list [--json]
 *   node tools/admin-cli.mjs dump-hash <用户名|class:班级码>
 *   node tools/admin-cli.mjs set-password <用户名>        # 新密码从 stdin 读
 *   node tools/admin-cli.mjs set-class-password <班级码>  # 新密码从 stdin 读
 *   node tools/admin-cli.mjs verify <用户名>              # 待校验密码从 stdin 读
 *   node tools/admin-cli.mjs restore-hash <备份json路径>
 *   node tools/admin-cli.mjs snapshot <目标db文件>         # SQLite 一致性快照（VACUUM INTO）
 *
 * 退出码：0 成功 / 1 通用失败 / 2 用法错误 / 3 目标不存在 / 4 密码不合规 / 5 数据库不可用
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
/** 安装根目录（tools/ 的上一级） */
const installDir = path.resolve(scriptDir, '..');
const serverDist = path.join(installDir, 'server', 'dist');

const EXIT = { OK: 0, FAIL: 1, USAGE: 2, NOT_FOUND: 3, WEAK: 4, NO_DB: 5 };

function fail(message, code = EXIT.FAIL) {
  process.stderr.write(`admin-cli: ${message}\n`);
  process.exitCode = code;
  return null;
}

/** 一次性读完 stdin（去掉行尾换行；保留内部空白，密码里可以有空格） */
async function readSecretFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

/** 与服务端一致的密码强度规则（classhelper 里还有一份交互式版本，两边保持同样口径） */
function checkStrength(password, username) {
  const problems = [];
  if (password.length < 8) problems.push('长度至少 8 位');
  if (password.length > 128) problems.push('长度不要超过 128 位');
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (kinds < 3) problems.push('需包含小写字母 / 大写字母 / 数字 / 符号 中至少 3 类');
  if (username && password.toLowerCase() === username.toLowerCase()) problems.push('不能与用户名相同');
  if (/^(123456|password|admin|classhelper|qwerty|111111|abc123)/i.test(password) && password.length < 12) {
    problems.push('过于常见，请换一个');
  }
  return problems;
}

/** 懒加载服务端模块：先做"库在不在"的检查，避免 libSQL 在连接时凭空建出一个空库 */
async function loadServerModules() {
  const envFile = path.join(serverDist, 'config', 'env.js');
  if (!fs.existsSync(envFile)) {
    fail(`找不到服务端产物：${envFile}`, EXIT.NO_DB);
    return null;
  }
  const env = await import(pathToFileURL(envFile).href);
  if (env.env.databaseProvider === 'sqlite') {
    // classhelper 做备份时会用 CLASSHELPER_SNAPSHOT_DB 显式指定数据文件（跳过硬编码路径假设）
    const dbFile = process.env.CLASSHELPER_SNAPSHOT_DB || env.env.sqliteFilePath;
    if (!dbFile || !fs.existsSync(dbFile)) {
      fail(
        `数据库文件不存在：${dbFile || '(未配置)'}\n` +
          '  提示：全新安装请先 systemctl start classhelper 完成建表（AUTO_MIGRATE）；',
        EXIT.NO_DB,
      );
      return null;
    }
  }
  const db = await import(pathToFileURL(path.join(serverDist, 'lib', 'db.js')).href);
  const password = await import(pathToFileURL(path.join(serverDist, 'lib', 'password.js')).href);
  return { env: env.env, prisma: db.prisma, disconnectPrisma: db.disconnectPrisma, ...password };
}

/** 目标账号：普通用户按 username，班级账号按 Class.code（ClassHelper 班级端登录用的是班级码） */
async function resolveTarget(prisma, key) {
  if (key.startsWith('class:')) {
    const code = key.slice('class:'.length).toUpperCase();
    const klass = await prisma.class.findUnique({ where: { code } });
    if (!klass) return { error: `班级码不存在：${code}`, code: EXIT.NOT_FOUND };
    return { kind: 'class', id: klass.id, label: `班级 ${klass.name}（码 ${klass.code}）`, hash: klass.passwordHash };
  }
  const user = await prisma.user.findUnique({ where: { username: key } });
  if (!user) return { error: `用户名不存在：${key}`, code: EXIT.NOT_FOUND };
  if (user.role === 'STUDENT') {
    return {
      error: `学生没有个人账号（${key} 只是名单记录），ClassHelper 班级端用「班级码 + 班级密码」登录，请用 --class 改班级密码`,
      code: EXIT.NOT_FOUND,
    };
  }
  return { kind: 'user', id: user.id, label: `${user.name}（${user.username} / ${user.role}）`, hash: user.passwordHash };
}

/* ------------------------------------------------------------------ 子命令 */

/**
 * SQLite 一致性快照：`VACUUM INTO` 在服务运行中也能拿到自洽的副本
 * （直接 cp 数据文件可能抓到写入中的中间状态）。
 * 目标文件必须不存在 —— 这是 SQLite 的硬要求，先删掉。
 */
async function cmdSnapshot(modules, dest) {
  const { env, prisma } = modules;
  if (env.databaseProvider !== 'sqlite') {
    return fail('snapshot 只支持 SQLite；MySQL 请用 mysqldump', EXIT.FAIL);
  }
  const target = path.resolve(dest);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { force: true });
  // VACUUM INTO 不接受参数占位符，只能拼字面量 —— 单引号按 SQL 规则翻倍转义
  await prisma.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  if (!fs.existsSync(target)) return fail('快照未生成（VACUUM INTO 未报错但没有产出文件）', EXIT.FAIL);
  process.stdout.write(`${target}\n`);
}

async function cmdInfo(modules) {
  const { env, prisma } = modules;
  const counts = {};
  for (const model of ['user', 'class', 'course', 'schedule', 'homework', 'notification', 'grade']) {
    counts[model] = await prisma[model].count();
  }
  const payload = {
    provider: env.databaseProvider,
    sqliteFile: env.sqliteFilePath || null,
    serverRoot: env.serverRoot,
    termStartDate: env.termStartDate || null,
    counts,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function cmdList(modules, asJson) {
  const { prisma } = modules;
  const users = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'TEACHER'] } },
    select: { username: true, name: true, role: true, classId: true, updatedAt: true },
    orderBy: [{ role: 'asc' }, { username: 'asc' }],
  });
  const classes = await prisma.class.findMany({
    select: { code: true, name: true, passwordHash: true },
    orderBy: { code: 'asc' },
  });

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          users,
          classes: classes.map((item) => ({ code: item.code, name: item.name, hasPassword: !!item.passwordHash })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write('可登录账号（教师 / 管理员）：\n');
  for (const user of users) {
    process.stdout.write(`  ${user.role.padEnd(8)} ${user.username.padEnd(16)} ${user.name}\n`);
  }
  process.stdout.write('\n班级账号（ClassHelper 班级端用「班级码 + 班级密码」登录）：\n');
  for (const item of classes) {
    const state = item.passwordHash ? '已设置' : '⚠ 未设置密码（该班当前无法登录）';
    process.stdout.write(`  ${item.code.padEnd(8)} ${item.name.padEnd(16)} ${state}\n`);
  }
}

async function cmdDumpHash(modules, key) {
  const { prisma } = modules;
  const target = await resolveTarget(prisma, key);
  if (target.error) return fail(target.error, target.code);
  if (!target.hash) return fail(`${target.label} 当前没有密码（passwordHash 为空）`, EXIT.NOT_FOUND);
  // 只给调用方（root）看的原始数据，不落到本工具的日志里
  process.stdout.write(`${JSON.stringify({ target: key, kind: target.kind, id: target.id, hash: target.hash })}\n`);
}

async function cmdSetPassword(modules, key, readSecret) {
  const { prisma, hashPassword } = modules;
  const target = await resolveTarget(prisma, key);
  if (target.error) return fail(target.error, target.code);

  const secret = await readSecret();
  const problems = checkStrength(secret, key);
  if (problems.length > 0) return fail(`密码不合规：${problems.join('；')}`, EXIT.WEAK);

  const hash = await hashPassword(secret);
  if (target.kind === 'class') {
    await prisma.class.update({ where: { id: target.id }, data: { passwordHash: hash } });
  } else {
    await prisma.user.update({ where: { id: target.id }, data: { passwordHash: hash } });
  }

  // 写完立刻复核一次：曾经出现过"bcrypt 参数不一致导致写进去的哈希验证不过"的排查成本
  const ok = await modules.verifyPassword(secret, hash);
  if (!ok) return fail('写入后复核失败：哈希无法通过校验，请用 restore-hash 回滚', EXIT.FAIL);

  process.stdout.write(`已更新密码：${target.label}\n`);
}

async function cmdVerify(modules, key, readSecret) {
  const { prisma, verifyPassword } = modules;
  const target = await resolveTarget(prisma, key);
  if (target.error) return fail(target.error, target.code);
  const secret = await readSecret();
  const ok = !!target.hash && (await verifyPassword(secret, target.hash));
  process.stdout.write(`${ok ? 'match' : 'mismatch'}\n`);
  if (!ok) process.exitCode = EXIT.FAIL;
}

async function cmdRestoreHash(modules, backupFile) {
  const { prisma } = modules;
  if (!fs.existsSync(backupFile)) return fail(`备份文件不存在：${backupFile}`, EXIT.NOT_FOUND);
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  } catch (error) {
    return fail(`备份文件不是合法 JSON：${error.message}`);
  }
  const { target, hash } = payload;
  if (typeof target !== 'string' || typeof hash !== 'string') {
    return fail('备份文件缺少 target / hash 字段，拒绝回滚');
  }
  if (target.startsWith('class:')) {
    await prisma.class.update({ where: { code: target.slice('class:'.length).toUpperCase() }, data: { passwordHash: hash } });
  } else {
    await prisma.user.update({ where: { username: target }, data: { passwordHash: hash } });
  }
  process.stdout.write(`已回滚密码哈希：${target}\n`);
}

/* ------------------------------------------------------------------ 入口 */

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';
const args = argv.slice(1);
const wantsJson = args.includes('--json');
const positional = args.filter((item) => !item.startsWith('--'));

function usage() {
  process.stdout.write(
    [
      'classhelper 离线账号工具（一般由 classhelper 命令调用）',
      '',
      '  info                              输出数据库与表行数（JSON）',
      '  list [--json]                     列出可登录账号与班级账号',
      '  dump-hash <用户名|class:班级码>    输出当前密码哈希（供改密前备份）',
      '  set-password <用户名>             从 stdin 读新密码并写入',
      '  set-class-password <班级码>       从 stdin 读新密码并写入班级账号',
      '  verify <用户名>                   从 stdin 读密码，输出 match / mismatch',
      '  restore-hash <备份json路径>       用备份文件里的哈希回滚',
      '  snapshot <目标db文件>             把 SQLite 库一致性快照到指定路径（VACUUM INTO）',
      '',
    ].join('\n'),
  );
}

if (command === 'help' || command === '--help' || command === '-h') {
  usage();
} else if (
  ![
    'info',
    'list',
    'dump-hash',
    'set-password',
    'set-class-password',
    'verify',
    'restore-hash',
    'snapshot',
  ].includes(command)
) {
  fail(`未知子命令：${command}\n`, EXIT.USAGE);
  usage();
} else {
  const modules = await loadServerModules();
  if (!modules) {
    // 已经在 loadServerModules 里设了 exitCode
  } else {
    try {
      switch (command) {
        case 'info':
          await cmdInfo(modules);
          break;
        case 'list':
          await cmdList(modules, wantsJson);
          break;
        case 'dump-hash':
          if (!positional[0]) fail('缺少目标账号', EXIT.USAGE);
          else await cmdDumpHash(modules, positional[0]);
          break;
        case 'set-password':
        case 'set-class-password': {
          const key = command === 'set-class-password' ? `class:${positional[0] ?? ''}` : (positional[0] ?? '');
          if (!positional[0]) fail('缺少目标账号', EXIT.USAGE);
          else await cmdSetPassword(modules, key, readSecretFromStdin);
          break;
        }
        case 'verify':
          if (!positional[0]) fail('缺少目标账号', EXIT.USAGE);
          else await cmdVerify(modules, positional[0], readSecretFromStdin);
          break;
        case 'restore-hash':
          if (!positional[0]) fail('缺少备份文件路径', EXIT.USAGE);
          else await cmdRestoreHash(modules, positional[0]);
          break;
        case 'snapshot':
          if (!positional[0]) fail('缺少目标文件路径', EXIT.USAGE);
          else await cmdSnapshot(modules, positional[0]);
          break;
        default:
          usage();
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      // 不用 process.exit()：在顶层 await 里硬退会踩 libuv 断言（见 AGENTS.md §7）
      await modules.disconnectPrisma();
    }
  }
}
