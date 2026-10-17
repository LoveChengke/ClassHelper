import path from 'node:path';
import type { AutostartStatusDto } from '@classhelper/shared';
import { ApiError } from '../../lib/http.js';
export interface AutostartHost {
  platform: string;
  root: string;
  exists: (file: string) => boolean;
  run: (file: string, args: string[]) => { ok: boolean; output: string };
}
/** 可注入的操作系统适配器；验证只替换 run，不写真实注册表或调用 systemctl。 */
export function createAutostartController(host: AutostartHost) {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    name = 'ClassHelperServer';
  const cmd = path.join(host.root, 'start.cmd');
  const unsupported = (detail: string): AutostartStatusDto => ({
    supported: false,
    enabled: false,
    mechanism: 'unsupported',
    detail,
  });
  function read(): AutostartStatusDto {
    if (host.platform === 'win32') {
      if (!host.exists(cmd))
        return unsupported('未检测到服务端安装目录的 start.cmd；开发环境不提供开机自启动切换');
      const install = host.run('reg.exe', ['query', 'HKCU\\Software\\ClassHelperServer', '/v', 'InstallDir']);
      const installedRoot = install.output.match(/REG_SZ\s+(.+)$/m)?.[1]?.trim();
      if (
        !install.ok ||
        !installedRoot ||
        path.resolve(installedRoot).toLowerCase() !== path.resolve(host.root).toLowerCase()
      )
        return unsupported('当前为开发或免安装目录；请使用服务端安装程序安装后设置开机自启动');
      const result = host.run('reg.exe', ['query', key, '/v', name]);
      const value = result.output.match(/REG_SZ\s+(.+)$/m)?.[1]?.trim();
      return {
        supported: true,
        enabled: result.ok && value === `"${cmd}"`,
        mechanism: 'run-key',
        detail: `登录 Windows 后运行 ${cmd}（HKCU Run / ${name}）`,
      };
    }
    if (host.platform === 'linux') {
      if (!host.exists('/run/systemd/system') || !host.exists('/etc/systemd/system/classhelper.service'))
        return unsupported(
          '未检测到正在运行的 systemd 与 classhelper 服务单元；容器或免安装环境不提供开机自启动切换',
        );
      const result = host.run('systemctl', ['is-enabled', 'classhelper']);
      return {
        supported: true,
        enabled: result.ok && /^enabled(?:-runtime)?\s*$/.test(result.output),
        mechanism: 'systemd',
        detail: 'systemctl enable/disable classhelper',
      };
    }
    return unsupported(`当前平台 ${host.platform} 不支持切换开机自启动`);
  }
  function write(enabled: boolean): AutostartStatusDto {
    const status = read();
    if (!status.supported) throw ApiError.badRequest(status.detail);
    if (status.enabled === enabled) return status;
    const result =
      status.mechanism === 'run-key'
        ? host.run(
            'reg.exe',
            enabled
              ? ['add', key, '/v', name, '/t', 'REG_SZ', '/d', `"${cmd}"`, '/f']
              : ['delete', key, '/v', name, '/f'],
          )
        : host.run('systemctl', [enabled ? 'enable' : 'disable', 'classhelper']);
    if (!result.ok) throw ApiError.badRequest(`无法修改开机自启动：${result.output}`);
    const after = read();
    if (after.enabled !== enabled)
      throw ApiError.badRequest('系统未保存所需的开机自启动状态，请检查账户权限与安装目录');
    return after;
  }
  return { read, write };
}
