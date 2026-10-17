import { verifyLayoutSmoke } from './smoke-layout.js';
import { verifyAgentSmoke } from './smoke-agent.js';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { getConfig } from './config.js';

/** 后台冒烟只检启动、桥接、缓存与窗口生命周期；屏幕像素和动画由显式视觉验收覆盖。 */
export async function runQuickSmoke(win: BrowserWindow): Promise<void> {
  const startedAt = Date.now();
  const results: Array<{ name: string; ok: boolean; detail: string; durationMs: number }> = [];
  async function check(name: string, action: () => Promise<boolean | string> | boolean): Promise<void> {
    const start = Date.now();
    try {
      const result = await action();
      results.push({
        name,
        ok: result !== false,
        detail: typeof result === 'string' ? result : '',
        durationMs: Date.now() - start,
      });
    } catch (error) {
      results.push({ name, ok: false, detail: String(error), durationMs: Date.now() - start });
    }
    const last = results.at(-1)!;
    console.log(`[${last.ok ? 'PASS' : 'FAIL'}] ${name}（${last.durationMs}ms）${last.detail}`);
  }
  await check('后台启动并挂载界面', async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (
        await win.webContents.executeJavaScript(
          `Boolean(window.__classhelperSmoke__ && document.querySelector('input, .el-menu-item'))`,
        )
      )
        return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  });
  await check('所有验证窗口保持隐藏且不获取焦点', () =>
    BrowserWindow.getAllWindows().every((item) => !item.isVisible() && !item.isFocused()),
  );
  await check('预加载桥接白名单', async () =>
    win.webContents.executeJavaScript(`Boolean(window.desktop?.getConfig && !window.desktop.ipcRenderer)`),
  );
  await check('渲染进程不能改写安装记录或设备身份', async () => {
    const before = getConfig();
    const after = await win.webContents.executeJavaScript(
      `window.desktop.saveConfig({ pendingUpdateFile: 'C:/unexpected.exe', pendingUpdateVersion: '999.0.0', deviceKey: 'unexpected' })`,
    );
    return (
      after.pendingUpdateFile === before.pendingUpdateFile &&
      after.pendingUpdateVersion === before.pendingUpdateVersion &&
      after.deviceKey === before.deviceKey
    );
  });
  for (const [name, method] of [
    ['IndexedDB 缓存读写', 'cacheSelfTest'],
    ['课表变更和重连立即刷新，慢学期接口与迟到响应不阻塞', 'islandScheduleSyncSelfTest'],
    ['断网缓存回退', 'offlineScenario'],
    ['服务端与班级缓存隔离', 'cacheIsolationSelfTest'],
  ]) {
    await check(name!, async () => {
      const result = await win.webContents.executeJavaScript(`window.__classhelperSmoke__.${method}()`);
      if (!result.ok) throw new Error(result.detail);
      return result.detail;
    });
  }
  if (process.env.ELECTRON_SMOKE_ONLINE === '1') {
    await check('后台登录与数据、实时通道集成', async () => {
      const credentials = {
        code: process.env.ELECTRON_SMOKE_CLASS_CODE ?? '',
        password: process.env.ELECTRON_SMOKE_CLASS_PASSWORD ?? '',
        serverUrl: (process.env.ELECTRON_SMOKE_API ?? 'http://127.0.0.1:4000/api').replace(/\/api\/?$/, ''),
      };
      const result = await win.webContents.executeJavaScript(
        `window.__classhelperSmoke__.onlineScenario(${JSON.stringify(credentials)})`,
      );
      if (!result.ok) throw new Error(result.detail);
      await win.webContents.executeJavaScript('window.__classhelperSmoke__.sessionCleanup()');
      return result.detail;
    });
  }
  await verifyAgentSmoke(check);
  await verifyLayoutSmoke(check);
  await check('检查结束时没有可见或聚焦的验证窗口', () =>
    BrowserWindow.getAllWindows().every((item) => !item.isVisible() && !item.isFocused()),
  );
  await check('关闭窗口仍隐藏而不销毁', () => {
    win.close();
    return !win.isDestroyed() && !win.isVisible() && app.isReady();
  });
  const failed = results.filter((result) => !result.ok);
  const result = {
    passed: results.length - failed.length,
    total: results.length,
    ok: !failed.length,
    mode: 'quick',
    durationMs: Date.now() - startedAt,
    results,
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
  };
  if (process.env.ELECTRON_SMOKE_RESULT) {
    fs.mkdirSync(path.dirname(process.env.ELECTRON_SMOKE_RESULT), { recursive: true });
    fs.writeFileSync(process.env.ELECTRON_SMOKE_RESULT, JSON.stringify(result, null, 2));
  }
  console.log(`[SMOKE] 后台快速检查 ${result.passed}/${result.total} 项通过，${result.durationMs}ms`);
  app.exit(failed.length ? 1 : 0);
}
