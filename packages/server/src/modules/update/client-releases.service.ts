import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  API_PREFIX,
  CLIENT_RELEASE_DIR,
  clientReleaseDownloadUrl,
  clientReleaseFileName,
  compareVersions,
  type ClientReleaseDto,
  type ClientUpdateInfoDto,
} from '@classhelper/shared';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/db.js';
import { ApiError } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import type { FetchClientReleaseInput, RegisterClientReleaseInput } from './update.schemas.js';

/**
 * 客户端安装包在服务端的缓存。
 *
 * 为什么要有这一层：教室机器常常**没有外网**，而"统一下发客户端更新"必须能落到
 * 那些机器上。于是服务端替它们代下（或由管理员手工放一份）并缓存到
 * `data/client-releases/<版本>/`，客户端再从 `GET /api/update/client/download/:version` 拉。
 *
 * 两个入口都**不传二进制**（服务端没有 multipart，也不打算为这一件事加）：
 * - `fetch`：服务端自己去 GitHub Releases 下（Web 端受 CSP 约束不能直连 GitHub，见 §5 第 52 条）；
 * - `register`：文件已由管理员放进磁盘（内网分发、U 盘、CI 产物），服务端只算 sha256 并登记。
 */

/** 代下大文件时的超时（安装包约 100MB，机房线路慢要留足） */
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;

type ReleaseRow = {
  id: string;
  version: string;
  fileName: string;
  sha256: string;
  size: number;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
};

function releaseRoot(): string {
  // 与 database 模块的备份目录同口径：<serverRoot>/../data
  const dir = path.join(env.serverRoot, '..', 'data', CLIENT_RELEASE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function releaseDir(version: string): string {
  return path.join(releaseRoot(), version);
}

function releaseFilePath(version: string, fileName: string): string {
  return path.join(releaseDir(version), fileName);
}

function toReleaseDto(row: ReleaseRow): ClientReleaseDto {
  return {
    version: row.version,
    fileName: row.fileName,
    size: row.size,
    sha256: row.sha256,
    notes: row.notes,
    fileReady: fs.existsSync(releaseFilePath(row.version, row.fileName)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function sha256Of(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** GET /api/update/client/releases - 已缓存的安装包（按版本从新到旧） */
export async function listReleases(): Promise<ClientReleaseDto[]> {
  const rows = (await prisma.clientRelease.findMany()) as unknown as ReleaseRow[];
  return rows
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((row) => toReleaseDto(row));
}

/** 服务端缓存的**最新**版本（推送更新时省略 version 就用它） */
export async function latestReleaseVersion(): Promise<string> {
  const rows = (await prisma.clientRelease.findMany()) as unknown as ReleaseRow[];
  const ready = rows.filter((row) => fs.existsSync(releaseFilePath(row.version, row.fileName)));
  ready.sort((a, b) => compareVersions(b.version, a.version));
  return ready[0]?.version ?? '';
}

/**
 * 某个版本的下载信息（心跳响应里带给客户端）。
 * 文件不在磁盘上时返回 null —— 客户端据此提示"服务端还没有这份安装包"。
 */
export async function resolveUpdateInfo(version: string): Promise<ClientUpdateInfoDto | null> {
  const wanted = version.trim();
  if (!wanted) return null;
  const row = (await prisma.clientRelease.findUnique({ where: { version: wanted } })) as ReleaseRow | null;
  if (!row) return null;
  if (!fs.existsSync(releaseFilePath(row.version, row.fileName))) return null;
  return {
    version: row.version,
    fileName: row.fileName,
    size: row.size,
    sha256: row.sha256,
    notes: row.notes,
    // 含 /api 前缀：客户端用「服务器地址 + 它」直接下载
    url: `${API_PREFIX}/update/client/download/${encodeURIComponent(row.version)}`,
  };
}

/** 绝对路径（下载路由用）；文件不存在返回 null */
export async function resolveReleaseFile(version: string): Promise<{ file: string; fileName: string } | null> {
  const row = (await prisma.clientRelease.findUnique({ where: { version } })) as ReleaseRow | null;
  if (!row) return null;
  const file = releaseFilePath(row.version, row.fileName);
  if (!fs.existsSync(file)) return null;
  return { file, fileName: row.fileName };
}

/** 登记一份已经在磁盘上的安装包：算 sha256 / 大小后落库（可重复登记，会覆盖） */
export async function registerRelease(
  userId: string,
  input: RegisterClientReleaseInput,
): Promise<ClientReleaseDto> {
  const version = input.version;
  // 文件名默认走发布命名约定（与 GitHub Release、官网兜底直链一致）
  const known = (await prisma.clientRelease.findUnique({ where: { version } })) as ReleaseRow | null;
  const fileName = input.fileName ?? known?.fileName ?? clientReleaseFileName(version);
  const file = releaseFilePath(version, fileName);

  if (!fs.existsSync(file)) {
    throw ApiError.badRequest(
      `没找到安装包文件「${fileName}」，请先把它放进 data/${CLIENT_RELEASE_DIR}/${version}/ 再登记`,
    );
  }

  const stat = fs.statSync(file);
  const sha256 = await sha256Of(file);
  const row = (await prisma.clientRelease.upsert({
    where: { version },
    create: {
      version,
      fileName,
      sha256,
      size: stat.size,
      notes: input.notes?.trim() ?? '',
      createdBy: userId,
    },
    update: {
      fileName,
      sha256,
      size: stat.size,
      ...(input.notes !== undefined ? { notes: input.notes.trim() } : {}),
    },
  })) as ReleaseRow;

  logger.info(`登记客户端安装包 v${version}（${fileName}，${stat.size} 字节，sha256=${sha256.slice(0, 12)}…）`);
  return toReleaseDto(row);
}

/** 让服务端从 GitHub 拉一份安装包并登记（教室无外网时由服务端代下） */
export async function fetchReleaseFromGithub(
  userId: string,
  input: FetchClientReleaseInput,
): Promise<ClientReleaseDto> {
  const version = input.version;
  const fileName = clientReleaseFileName(version);
  const url = clientReleaseDownloadUrl(version);
  const target = releaseFilePath(version, fileName);

  fs.mkdirSync(releaseDir(version), { recursive: true });
  logger.info(`开始从 GitHub 拉取客户端安装包 v${version}：${url}`);

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'ClassHelper-Server' },
    });
  } catch (error) {
    throw ApiError.badRequest(
      `下载失败：${error instanceof Error ? error.message : String(error)}。` +
        `可以把安装包手工放进 data/${CLIENT_RELEASE_DIR}/${version}/ 再点「登记」`,
    );
  }

  if (!response.ok || !response.body) {
    throw ApiError.badRequest(
      `GitHub 上没有 v${version} 的客户端安装包（HTTP ${response.status}，文件名应为 ${fileName}）`,
    );
  }

  try {
    await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(target));
  } catch (error) {
    fs.rmSync(target, { force: true });
    throw ApiError.badRequest(`写入安装包失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // 落盘后统一走登记：sha256 / 大小 / 落库都在同一处算
  return registerRelease(userId, { version, fileName });
}

/** 删除一份缓存的安装包（元数据 + 磁盘文件） */
export async function deleteRelease(version: string): Promise<{ version: string }> {
  const row = (await prisma.clientRelease.findUnique({ where: { version } })) as ReleaseRow | null;
  if (!row) throw ApiError.notFound('服务端没有这个版本的安装包');
  await prisma.clientRelease.delete({ where: { version } });
  fs.rmSync(releaseDir(version), { recursive: true, force: true });
  logger.info(`删除客户端安装包 v${version}（${row.fileName}）`);
  return { version };
}
