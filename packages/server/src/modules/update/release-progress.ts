import { SOCKET_EVENTS, SOCKET_ROOMS, type ReleaseProgressDto } from '@classhelper/shared';
import { emitToRooms } from '../../realtime/bus.js';

// 下载状态只属于本次进程；重启回到 idle，不会残留无法完成的 downloading。
let progress: ReleaseProgressDto = {
  version: '',
  stage: 'idle',
  downloadedBytes: 0,
  totalBytes: 0,
  percent: null,
  error: '',
};
let lastEmit = 0;
export function getReleaseProgress() {
  return { ...progress };
}
export function setReleaseProgress(patch: Partial<ReleaseProgressDto>) {
  const stageChanged = patch.stage && patch.stage !== progress.stage;
  progress = { ...progress, ...patch };
  progress.percent = progress.totalBytes
    ? Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
    : null;
  if (stageChanged || Date.now() - lastEmit >= 250) {
    emitToRooms([SOCKET_ROOMS.role('ADMIN')], SOCKET_EVENTS.clientReleaseProgress, getReleaseProgress());
    lastEmit = Date.now();
  }
}
