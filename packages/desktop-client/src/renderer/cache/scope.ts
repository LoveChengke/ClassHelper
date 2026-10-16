let activeScope = 'anonymous';
const listeners = new Set<() => void>();

/** 同一台机器可切换服务端与班级，两者都必须纳入缓存命名空间。 */
export function setCacheScope(server: string, identity: string): void {
  const next = `${encodeURIComponent(server.replace(/\/+$/, ''))}@${encodeURIComponent(identity)}`;
  if (next === activeScope) return;
  activeScope = next;
  for (const listener of listeners) listener();
}
export function getCacheScope(): string {
  return activeScope;
}
export function scopedKey(key: string, scope = activeScope): string {
  return `${scope}::${key}`;
}
export function onCacheScopeChanged(listener: () => void): void {
  listeners.add(listener);
}
export function profileCacheKey(server: string, username: string): string {
  return `${encodeURIComponent(server.replace(/\/+$/, ''))}@${encodeURIComponent(username)}::profile`;
}
