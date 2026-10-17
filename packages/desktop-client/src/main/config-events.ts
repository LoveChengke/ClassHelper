import { EventEmitter } from 'node:events';
export type ConnectionEvent = 'server-changed' | 'token-changed' | 'login' | 'logout';
export const connectionEvents = new EventEmitter();
export function connectionChanged(event: ConnectionEvent) {
  connectionEvents.emit('changed', event);
}
