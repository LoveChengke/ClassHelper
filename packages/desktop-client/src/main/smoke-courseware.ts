/** 本地 HTTP 替身验证真实下载管线；只使用冒烟专属 userData，不连接真实服务端。 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import type { CoursewareDto } from '@classhelper/shared';
import { defaultIslandLayouts } from '@classhelper/shared';
import { getConfig, saveConfig } from './config.js';
import { downloadCourseware, getCoursewareTransfer } from './courseware.js';
import { island } from './island.js';
export async function verifyCoursewareSmoke(
  check: (name: string, action: () => Promise<boolean | string> | boolean) => Promise<void>,
) {
  if (process.env.ELECTRON_SMOKE_TEST !== '1' || !app.getPath('userData').includes('smoke'))
    throw new Error('课件自检只允许使用冒烟临时配置');
  const original = getConfig(),
    bytes = Buffer.alloc(1024 * 1024, 83);
  let corrupt = false,
    downloads = 0,
    slow = false;
  const item: CoursewareDto = {
    id: 'courseware-smoke',
    name: '课件接收验证.pptx',
    size: bytes.length,
    category: 'presentation',
    extension: 'pptx',
    archiveDate: '2026-10-18',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    createdAt: new Date().toISOString(),
    teacher: { id: 'temporary-teacher', name: '临时课件教师' },
    classes: [],
  };
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith('/download')) {
      downloads++;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
      let offset = 0;
      const timer = setInterval(
        () => {
          const chunk = bytes.subarray(offset, offset + 32768);
          res.write(corrupt ? Buffer.alloc(chunk.length) : chunk);
          offset += chunk.length;
          if (offset >= bytes.length) {
            clearInterval(timer);
            res.end();
          }
        },
        slow ? 100 : 12,
      );
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: true, data: item, message: 'ok' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const wait = async (predicate: () => boolean | Promise<boolean>) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return false;
  };
  async function localFiles(dir = path.join(app.getPath('userData'), 'courseware')): Promise<string[]> {
    return (
      await Promise.all(
        (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).map((entry) =>
          entry.isDirectory() ? localFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
        ),
      )
    ).flat();
  }
  try {
    saveConfig({
      serverUrl: `http://127.0.0.1:${port}`,
      username: 'courseware-smoke',
      token: 'local-courseware-smoke',
      islandLayout: defaultIslandLayouts(),
    });
    island.syncCustomLayout();
    const job = downloadCourseware(item.id);
    await check('课件后台下载去重且持续报告真实字节进度', async () => {
      const same = job === downloadCourseware(item.id);
      const progressed = await wait(() => {
        const value = getCoursewareTransfer();
        return !!value && value.progress > 0 && value.progress < 100;
      });
      return same && progressed && getCoursewareTransfer()?.teacherName === item.teacher.name;
    });
    await job;
    await check('课件校验完成后保存正式文件并显示完成', async () => {
      const files = await localFiles();
      return (
        getCoursewareTransfer()?.stage === 'completed' &&
        getCoursewareTransfer()?.progress === 100 &&
        files.length === 1 &&
        (await fs.readFile(files[0]!)).equals(bytes)
      );
    });
    await check('已完整接收的相同课件不重复传输', async () => {
      await downloadCourseware(item.id);
      return downloads === 1;
    });
    for (const layout of ['fixed', 'custom'] as const) {
      await check(
        `${layout === 'fixed' ? '固定岛' : '自定义常驻岛'}显示课件名称、类型、教师和进度`,
        async () => {
          saveConfig({ islandLayout: { ...defaultIslandLayouts(), layout } });
          island.syncCustomLayout();
          island.setCoursewareTransfer({
            id: item.id,
            name: item.name,
            category: item.category,
            teacherName: item.teacher.name,
            receivedBytes: 512000,
            totalBytes: item.size,
            progress: 48,
            stage: 'downloading',
          });
          return wait(
            async () =>
              !!(await island
                .getWindow()!
                .webContents.executeJavaScript(
                  `(() => {const card=document.querySelector('.courseware-transfer');return card?.textContent.includes('课件接收验证.pptx')&&card.textContent.includes('临时课件教师')&&card.textContent.includes('演示文稿')&&card.querySelector('progress')?.value===48;})()`,
                )),
          );
        },
      );
    }
    await check('紧急通知优先展示，关闭后恢复课件进度', async () => {
      island.pushNotification({
        id: 'courseware-urgent',
        title: '紧急通知优先',
        content: '课件接收继续进行',
        priority: 'URGENT',
        createdAt: new Date().toISOString(),
      });
      const urgent =
        island.getState().mode === 'expanded' &&
        !island.getState().coursewareTransfer &&
        island.getCoursewareTransfer()?.progress === 48;
      island.removeNotification('courseware-urgent');
      return urgent && (await wait(() => island.getState().coursewareTransfer?.progress === 48));
    });
    island.setCoursewareTransfer(null);
    item.id = 'corrupt-courseware';
    corrupt = true;
    await check('摘要不匹配时拒绝保存且清理临时文件', async () => {
      let rejected = false;
      try {
        await downloadCourseware(item.id);
      } catch {
        rejected = true;
      }
      return (
        rejected &&
        getCoursewareTransfer()?.stage === 'failed' &&
        !(await localFiles()).some((file) => file.includes(item.id))
      );
    });
    corrupt = false;
    slow = true;
    item.id = 'cancel-courseware';
    const cancelled = downloadCourseware(item.id).then(
      () => false,
      () => true,
    );
    await wait(() => getCoursewareTransfer()?.id === item.id && (getCoursewareTransfer()?.progress ?? 0) > 0);
    saveConfig({ token: null });
    await check(
      '切换登录会话会中止接收并清理进度与临时文件',
      async () =>
        (await cancelled) &&
        getCoursewareTransfer() === null &&
        !(await localFiles()).some((file) => file.endsWith('.part')),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    saveConfig({
      serverUrl: original.serverUrl,
      username: original.username,
      token: original.token,
      islandLayout: original.islandLayout,
    });
    island.setCoursewareTransfer(null);
    island.syncCustomLayout();
    island.getWindow()?.hide();
  }
}
