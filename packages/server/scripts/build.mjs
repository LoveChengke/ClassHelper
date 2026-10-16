/** 先清理编译目录，确保已移除的模块不会残留在下一次交付物中。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
