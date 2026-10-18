import type { ReadableStream } from 'node:stream/web';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { app, BrowserWindow, shell } from 'electron';
import {
  COURSEWARE_MAX_BYTES,
  COURSEWARE_TRANSFER_TIMEOUT_MS,
  coursewareArchivePath,
  coursewarePathSegment,
  type ApiResponse,
  type CoursewareDto,
  type CoursewarePushDto,
  type CoursewareTransfer,
} from '@classhelper/shared';
import { getConfig } from './config.js';
import { connectionEvents } from './config-events.js';
import { island } from './island.js';
import { logger } from './logger.js';

let transfer: CoursewareTransfer | null = null,
  epoch = 0;
let abort: AbortController | null = null,
  polling = false;
let queue: Promise<unknown> = Promise.resolve();
const jobs = new Map<string, Promise<void>>();
let clearTimer: ReturnType<typeof setTimeout> | undefined;
export function getCoursewareTransfer() {
  return transfer;
}
function publish(value: CoursewareTransfer | null) {
  transfer = value;
  island.setCoursewareTransfer(value);
  for (const win of BrowserWindow.getAllWindows())
    if (!win.isDestroyed()) win.webContents.send('courseware:progress', value);
}
connectionEvents.on('changed', () => {
  epoch++;
  abort?.abort();
  clearTimeout(clearTimer);
  publish(null);
});
function checkId(id: string) {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(id)) throw new Error('课件编号无效');
}
function scopeDirectory() {
  const config = getConfig();
  const scope = createHash('sha256')
    .update(`${config.serverUrl}\n${config.username}`)
    .digest('hex')
    .slice(0, 24);
  return path.join(app.getPath('userData'), 'courseware', scope);
}
async function json<T>(route: string, signal: AbortSignal, body?: object): Promise<T> {
  const config = getConfig();
  if (!config.token) throw new Error('请先登录班级账号');
  const response = await fetch(`${config.serverUrl}/api/courseware${route}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
    redirect: 'error',
  });
  const value = (await response.json()) as ApiResponse<T>;
  if (!response.ok || !value.success) throw new Error(value.message || `请求失败（${response.status}）`);
  return value.data;
}
async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
interface LocalCourseware {
  item: CoursewareDto;
  relativePath: string;
}
function localFile(root: string, relative: string) {
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error('课件路径无效');
  return file;
}
async function localRecord(id: string, root = scopeDirectory()): Promise<LocalCourseware | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(root, '.index', `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}
export async function listLocalCourseware(): Promise<CoursewareDto[]> {
  if (!getConfig().token) return [];
  const root = scopeDirectory();
  const startedEpoch = epoch;
  const names = await fsp.readdir(path.join(root, '.index')).catch(() => []);
  const result: CoursewareDto[] = [];
  for (const name of names.filter((name) => /^[a-z0-9-]+\.json$/i.test(name))) {
    const record = await localRecord(name.slice(0, -5), root);
    if (record && fs.existsSync(localFile(root, record.relativePath))) result.push(record.item);
  }
  return startedEpoch === epoch ? result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
}
export function downloadCourseware(id: string): Promise<void> {
  checkId(id);
  const startedEpoch = epoch,
    key = `${epoch}:${id}`;
  const existing = jobs.get(key);
  if (existing) return existing;
  const job = queue
    .catch(() => undefined)
    .then(async () => {
      if (startedEpoch !== epoch) throw new Error('登录会话已切换');
      clearTimeout(clearTimer);
      abort = new AbortController();
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(COURSEWARE_TRANSFER_TIMEOUT_MS)]);
      const config = getConfig();
      let partial = '';
      try {
        const item = await json<CoursewareDto>(`/${encodeURIComponent(id)}`, signal);
        if (startedEpoch !== epoch) throw new Error('登录会话已切换');
        if (
          !Number.isInteger(item.size) ||
          item.size < 1 ||
          item.size > COURSEWARE_MAX_BYTES ||
          !/^[a-f0-9]{64}$/.test(item.sha256)
        )
          throw new Error('课件文件信息无效');
        const root = scopeDirectory();
        const stored = await localRecord(id, root);
        let relativePath =
          stored?.relativePath ||
          (item.archivePath || coursewareArchivePath(item.teacher.name, new Date(item.createdAt), item.name))
            .split('/')
            .map(coursewarePathSegment)
            .join(path.sep);
        let file = localFile(root, relativePath);
        // 同秒、同名文件不得覆盖先前课件；重试通过本地索引始终定位同一文件。
        if (!stored && fs.existsSync(file)) {
          const ext = path.extname(file);
          relativePath = relativePath.slice(0, relativePath.length - ext.length) + ` (${id})` + ext;
          file = localFile(root, relativePath);
        }
        const dir = path.dirname(file);
        partial = `${file}.part`;
        const base: CoursewareTransfer = {
          id,
          name: item.name,
          category: item.category,
          teacherName: item.teacher.name,
          receivedBytes: 0,
          totalBytes: item.size,
          progress: 0,
          stage: 'downloading',
        };
        publish(base);
        await fsp.mkdir(dir, { recursive: true });
        let valid = false;
        try {
          valid = (await fsp.stat(file)).size === item.size && (await digest(file)) === item.sha256;
        } catch {
          /* 尚未下载 */
        }
        if (!valid) {
          const response = await fetch(
            `${config.serverUrl}/api/courseware/${encodeURIComponent(id)}/download`,
            { headers: { authorization: `Bearer ${config.token}` }, signal, redirect: 'error' },
          );
          if (!response.ok || !response.body) throw new Error(`课件下载失败（HTTP ${response.status}）`);
          const hash = createHash('sha256');
          let received = 0,
            last = 0;
          await pipeline(
            Readable.fromWeb(response.body as ReadableStream),
            new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                received += chunk.length;
                if (received > item.size) return callback(new Error('课件大小不匹配'));
                hash.update(chunk);
                if (Date.now() - last > 120) {
                  last = Date.now();
                  if (startedEpoch === epoch)
                    publish({
                      ...base,
                      receivedBytes: received,
                      progress: Math.min(99, Math.floor((received / item.size) * 100)),
                    });
                }
                callback(null, chunk);
              },
            }),
            fs.createWriteStream(partial, { flags: 'w' }),
            { signal },
          );
          if (startedEpoch !== epoch) throw new Error('登录会话已切换');
          publish({ ...base, receivedBytes: received, progress: 99, stage: 'verifying' });
          if (received !== item.size || hash.digest('hex') !== item.sha256)
            throw new Error('课件校验失败，请重新下载');
          // 下载完成后再次检查可见权限，撤回的文件不得落成本地副本。
          await json<CoursewareDto>(`/${encodeURIComponent(id)}`, signal);
          if (startedEpoch !== epoch || signal.aborted) throw new Error('登录会话已切换或下载已取消');
          await fsp.rm(file, { force: true });
          await fsp.rename(partial, file);
        }
        if (startedEpoch !== epoch) throw new Error('登录会话已切换');
        await fsp.mkdir(path.join(root, '.index'), { recursive: true });
        const indexFile = path.join(root, '.index', `${id}.json`);
        await fsp.writeFile(
          `${indexFile}.part`,
          JSON.stringify({
            item: { ...item, archivePath: relativePath.split(path.sep).join('/') },
            relativePath,
          }),
          'utf8',
        );
        await fsp.rename(`${indexFile}.part`, indexFile);
        publish({ ...base, receivedBytes: item.size, progress: 100, stage: 'completed' });
      } catch (error) {
        if (partial) await fsp.rm(partial, { force: true }).catch(() => undefined);
        if (startedEpoch === epoch)
          publish({
            ...(transfer?.id === id
              ? transfer
              : {
                  id,
                  name: '课件',
                  category: 'other',
                  teacherName: '',
                  receivedBytes: 0,
                  totalBytes: 0,
                  progress: 0,
                }),
            stage: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        throw error;
      } finally {
        abort = null;
        if (startedEpoch === epoch)
          clearTimer = setTimeout(
            () => {
              if (transfer?.id === id) publish(null);
            },
            transfer?.stage === 'failed' ? 12000 : 5000,
          );
      }
    })
    .finally(() => jobs.delete(key));
  jobs.set(key, job);
  queue = job;
  // IPC 调用者或轮询负责呈现错误；队列自身始终有拒绝处理器。
  void job.catch(() => undefined);
  return job;
}
export async function pollCourseware() {
  if (polling || !getConfig().token || process.env.ELECTRON_SMOKE_TEST === '1') return;
  const startedEpoch = epoch,
    config = getConfig();
  polling = true;
  try {
    const tasks = await json<CoursewarePushDto[]>(
      `/transfers?deviceKey=${encodeURIComponent(config.deviceKey)}`,
      AbortSignal.timeout(10000),
    );
    for (const task of tasks) {
      if (startedEpoch !== epoch) break;
      try {
        await downloadCourseware(task.courseware.id);
        if (startedEpoch !== epoch) break;
        await json(`/transfers/${encodeURIComponent(task.id)}/ack`, AbortSignal.timeout(10000), {
          deviceKey: config.deviceKey,
        });
      } catch (error) {
        logger.warn(`课件接收失败，下次心跳重试：${String(error)}`);
      }
    }
  } catch (error) {
    logger.debug(`读取课件传输任务失败：${String(error)}`);
  } finally {
    polling = false;
  }
}
export async function revealCourseware(id: string) {
  checkId(id);
  if (!getConfig().token) throw new Error('请先登录班级账号');
  const stored = await localRecord(id);
  if (stored) {
    const file = localFile(scopeDirectory(), stored.relativePath);
    if (fs.existsSync(file)) {
      shell.showItemInFolder(file);
      return;
    }
  }
  const dir = path.join(scopeDirectory(), id);
  const names = await fsp.readdir(dir).catch(() => []);
  const file = names.find((name) => !name.endsWith('.part'));
  if (!file) throw new Error('请先完成课件下载');
  shell.showItemInFolder(path.join(dir, file));
}
