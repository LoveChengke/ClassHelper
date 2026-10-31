/** 首次安装生成独立密钥；覆盖升级不改变已有配置。 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MARKER = 'CLASSHELPER_GENERATE_SECRET_ON_INSTALL';
function initialiseEnvironment(file = path.join(__dirname, '.env')) {
  const content = fs.readFileSync(file, 'utf8');
  const line = /^JWT_SECRET=CLASSHELPER_GENERATE_SECRET_ON_INSTALL\r?$/m;
  if (!line.test(content)) return false;
  const value = crypto.randomBytes(48).toString('hex');
  const temporary = file + '.initialising-' + crypto.randomUUID();
  try {
    fs.writeFileSync(temporary, content.replace(line, 'JWT_SECRET=' + value), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return true;
}
module.exports = { initialiseEnvironment, MARKER };
if (require.main === module) {
  try {
    initialiseEnvironment();
  } catch (error) {
    console.error('服务端配置初始化失败：' + error.message);
    process.exitCode = 1;
  }
}
