import {
  EventStreamDecoder,
  STORAGE_KEYS,
  type AiAgentEvent,
  type AiConversationResult,
} from '@classhelper/shared';
import { API_BASE_URL } from '@/config';
import { clearCalendarCache } from './calendarCache';

export async function observeTask(
  id: string,
  onEvent: (event: AiAgentEvent) => void,
  signal?: AbortSignal,
): Promise<AiConversationResult> {
  const response = await fetch(`${API_BASE_URL}/ai/tasks/${encodeURIComponent(id)}/events`, {
    signal,
    headers: {
      authorization: `Bearer ${localStorage.getItem(STORAGE_KEYS.token) ?? ''}`,
      accept: 'text/event-stream',
    },
  });
  return consume(response, onEvent);
}
async function consume(
  response: Response,
  onEvent: (event: AiAgentEvent) => void,
): Promise<AiConversationResult> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      clearCalendarCache();
      localStorage.removeItem(STORAGE_KEYS.token);
      localStorage.removeItem(STORAGE_KEYS.user);
      window.location.assign('/login');
    }
    throw Object.assign(new Error(body.message || '暂时无法连接助手，任务已保留。'), { code: body.code });
  }
  if (!response.body) throw new Error('连接暂时中断，任务已保留。');
  const reader = response.body.getReader(),
    decoder = new TextDecoder(),
    events = new EventStreamDecoder(16 * 1024 * 1024);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const frame of events.push(decoder.decode(chunk.value, { stream: true }))) {
        const event = JSON.parse(frame) as AiAgentEvent;
        onEvent(event);
        if (event.type === 'error') throw Object.assign(new Error(event.message), { code: event.code });
        if (event.type === 'result') return event.result;
      }
    }
    throw new Error('连接暂时中断，任务已保留。点击重试继续。');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
