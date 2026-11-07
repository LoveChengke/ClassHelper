import { sha256 } from '@noble/hashes/sha2.js';
import type { AiAttachment } from '@classhelper/shared';

export async function hashAttachment(file: File, signal?: AbortSignal): Promise<AiAttachment> {
  const hash = sha256.create();
  const reader = file.stream().getReader();
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    sha256: [...hash.digest()].map((value) => value.toString(16).padStart(2, '0')).join(''),
  };
}

export async function importFileBase64(file: File): Promise<string> {
  if (file.size > 8 * 1024 * 1024) throw new Error('结构化导入文件不能超过 8 MB');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}
