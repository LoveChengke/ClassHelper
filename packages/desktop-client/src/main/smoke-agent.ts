import { createHash } from 'node:crypto';
import { considerUpdate, getUpdateProgress, syncUpdatePolicy } from './auto-update.js';
import { createServer } from 'node:http';
import { app } from 'electron';
import { getConfig, saveConfig } from './config.js';
import { beatNow, getClientAgentStatus, stopClientAgent, startClientAgent } from './client-agent.js';
export async function verifyAgentSmoke(
  check: (name: string, action: () => Promise<boolean | string> | boolean) => Promise<void>,
) {
  const original = getConfig(),
    previous = process.env.ELECTRON_SMOKE_CLIENT_AGENT;
  let firstCalls = 0,
    secondCalls = 0,
    acked = false,
    invalidToken = false;
  const one = createServer((req, res) => {
    firstCalls++;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const two = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer v14-local-fake-token') invalidToken = true;
    if (req.url === '/fake-installer') {
      res.setHeader('content-length', String(Buffer.byteLength('仅测试，不是可执行文件')));
      res.end('仅测试，不是可执行文件');
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url?.includes('/ack')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const value = JSON.parse(body);
        acked =
          value.deviceKey === original.deviceKey &&
          value.ok === true &&
          value.result.includes('冒烟假执行器');
        res.end(JSON.stringify({ success: true, data: {} }));
      });
      return;
    }
    secondCalls++;
    res.end(
      JSON.stringify({
        success: true,
        data: {
          deviceId: 'local-smoke-device',
          serverTime: new Date().toISOString(),
          updateTargetVersion: null,
          updateMode: 'idle',
          update: null,
          command: acked
            ? null
            : {
                id: `local-smoke-${app.getVersion()}-${Date.now()}`,
                deviceId: 'local-smoke-device',
                kind: 'lock',
                payload: '仅假执行',
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60000).toISOString(),
                ackedAt: null,
                result: '',
              },
        },
      }),
    );
  });
  await Promise.all([
    new Promise<void>((r) => one.listen(0, '127.0.0.1', r)),
    new Promise<void>((r) => two.listen(0, '127.0.0.1', r)),
  ]);
  const url = (server: typeof one) => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    process.env.ELECTRON_SMOKE_CLIENT_AGENT = '1';
    stopClientAgent();
    saveConfig({ serverUrl: url(one), token: 'v14-old-fake-token' });
    startClientAgent();
    await beatNow();
    await check(
      '401 后明确进入退避状态',
      () => firstCalls > 0 && getClientAgentStatus().lastError.includes('401'),
    );
    const begin = Date.now();
    saveConfig({ serverUrl: url(two) });
    await check(
      '换服务端清除旧令牌与退避，设备身份保持不变',
      () =>
        getConfig().token === null &&
        getConfig().deviceKey === original.deviceKey &&
        !getClientAgentStatus().lastError,
    );
    saveConfig({ token: 'v14-local-fake-token' });
    await beatNow();
    await check('新服务端登录后30秒内自动心跳', async () => {
      const deadline = Date.now() + 3000;
      while (secondCalls === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
      return secondCalls > 0 && Date.now() - begin < 30000 && getClientAgentStatus().online && !invalidToken;
    });
    await check('收到远控立即假执行并以deviceKey回执（未调用系统命令）', async () => {
      const deadline = Date.now() + 3000;
      while (!acked && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
      return acked;
    });
    await check('安装包哈希失败会显示失败并拒绝待安装记录', async () => {
      saveConfig({ autoUpdate: true });
      const info = {
        version: '99.0.0',
        fileName: 'smoke-update.exe',
        size: Buffer.byteLength('仅测试，不是可执行文件'),
        sha256: 'bad',
        notes: '仅本机假数据',
        url: '/fake-installer',
      };
      syncUpdatePolicy({
        deviceId: 'local-smoke-device',
        serverTime: new Date().toISOString(),
        command: null,
        update: null,
        updateTargetVersion: info.version,
        updateMode: 'idle',
        updateNotBefore: null,
      });
      await considerUpdate(info, info.version);
      return (
        getUpdateProgress().stage === 'failed' &&
        getUpdateProgress().error.includes('sha256') &&
        getConfig().pendingUpdateVersion !== info.version
      );
    });
    await check('下载字节与校验完成显示等待安装（冒烟禁止运行安装器）', async () => {
      const info = {
        version: '99.0.1',
        fileName: 'smoke-update.exe',
        size: Buffer.byteLength('仅测试，不是可执行文件'),
        sha256: createHash('sha256').update('仅测试，不是可执行文件').digest('hex'),
        notes: '仅本机假数据',
        url: '/fake-installer',
      };
      syncUpdatePolicy({
        deviceId: 'local-smoke-device',
        serverTime: new Date().toISOString(),
        command: null,
        update: null,
        updateTargetVersion: info.version,
        updateMode: 'idle',
        updateNotBefore: null,
      });
      await considerUpdate(info, info.version);
      const progress = getUpdateProgress();
      return (
        progress.stage === 'waiting' &&
        progress.percent === 100 &&
        progress.downloadedBytes === info.size &&
        getConfig().pendingUpdateVersion === info.version
      );
    });
  } finally {
    stopClientAgent();
    saveConfig(original);
    if (previous === undefined) delete process.env.ELECTRON_SMOKE_CLIENT_AGENT;
    else process.env.ELECTRON_SMOKE_CLIENT_AGENT = previous;
    startClientAgent();
    await Promise.all([
      new Promise<void>((r) => one.close(() => r())),
      new Promise<void>((r) => two.close(() => r())),
    ]);
  }
}
