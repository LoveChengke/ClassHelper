/** 同时用于模型和应用 SSE；保留跨网络块的 UTF-8 解码由调用方负责。 */
export class EventStreamDecoder {
  private buffer = '';
  constructor(private readonly maxBuffered = 1024 * 1024) {}
  push(chunk: string): string[] {
    this.buffer += chunk;
    if (this.buffer.length > this.maxBuffered) throw new Error('事件流单帧过大');
    const frames = this.buffer.split(/\r?\n\r?\n/);
    this.buffer = frames.pop() ?? '';
    return frames.flatMap((frame) => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      return data ? [data] : [];
    });
  }
}
