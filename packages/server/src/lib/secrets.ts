import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * 全局设置里"密钥类"值的加解密（目前只有大模型的 API Key）。
 *
 * 为什么不用明文存 `AppSetting`：那张表会进备份/导出/跨库迁移的快照，
 * 明文密钥等于把它写进了每一次备份。这里用 **AES-256-GCM**，密钥由 `JWT_SECRET`
 * 经 scrypt 派生（不需要新的环境变量），密文带 `v1:` 前缀便于将来轮换算法。
 *
 * 代价：`JWT_SECRET` 一改，旧密文就解不开了 —— 这是有意的（换密钥本来就该重新填密钥），
 * `decryptSecret()` 解不开时返回空串，AI 设置页会显示"未配置"。
 */
const KEY = crypto.scryptSync(env.jwtSecret, 'classhelper-app-setting', 32);

export function encryptSecret(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(payload: string): string {
  if (!payload.startsWith('v1:')) return '';
  const [, ivBase64 = '', tagBase64 = '', dataBase64 = ''] = payload.split(':');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivBase64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagBase64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataBase64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return '';
  }
}
