/** 仅供隔离验收：不启动年度升级、备份、PID 或其它后台运维任务。 */
import { createServer } from 'node:http';
import { createApp } from '../packages/server/src/app.js';
import { initRealtime } from '../packages/server/src/realtime/socket.js';
if (!process.env.DATABASE_URL?.includes('v14-verification'))
  throw new Error('验收服务只能使用专用临时数据库');
const localFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    return Promise.reject(new Error('隔离验收禁止访问外网'));
  return localFetch(input, init);
};
const server = createServer(createApp());
initRealtime(server);
server.listen(Number(process.env.PORT || 4105), '127.0.0.1', () =>
  console.log(`验收服务已就绪：${process.env.PORT || 4105}`),
);
