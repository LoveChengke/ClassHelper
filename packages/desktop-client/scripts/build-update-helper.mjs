import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

/** Windows 自带 .NET Framework 编译器；构建产物随客户端分发，不在教室机上编译。 */
export function buildUpdateHelper(output) {
  if (process.platform !== 'win32') return;
  const framework = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
  );
  const compiler = path.join(framework, 'csc.exe');
  if (!fs.existsSync(compiler)) throw new Error('缺少 Windows .NET Framework 编译器，无法构建更新助手');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync(
    compiler,
    [
      '/nologo',
      '/target:winexe',
      '/optimize+',
      '/platform:anycpu',
      `/reference:${path.join(framework, 'System.Web.Extensions.dll')}`,
      `/out:${output}`,
      fileURLToPath(new URL('../native/update-helper.cs', import.meta.url)),
    ],
    { stdio: 'pipe', windowsHide: true },
  );
}
