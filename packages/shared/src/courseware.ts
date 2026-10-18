/** 课件契约：文件先保存到服务端，再向可见班级下发下载任务。 */
export const COURSEWARE_MAX_BYTES = 512 * 1024 * 1024;
export const COURSEWARE_TRANSFER_TIMEOUT_MS = 30 * 60_000;
export const COURSEWARE_ISLAND_SIZE = { width: 424, height: 132 } as const;
export const COURSEWARE_CATEGORIES = {
  presentation: '演示文稿',
  document: '文档',
  spreadsheet: '表格',
  image: '图片',
  video: '视频',
  audio: '音频',
  archive: '压缩包',
  other: '其他',
} as const;
export type CoursewareCategory = keyof typeof COURSEWARE_CATEGORIES;
export function coursewareCategory(name: string): CoursewareCategory {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return 'presentation';
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'odt', 'rtf'].includes(ext)) return 'document';
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return 'spreadsheet';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'avi', 'mov', 'mkv', 'wmv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(ext)) return 'audio';
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(ext)) return 'archive';
  return 'other';
}
export interface CoursewareClassDto {
  id: string;
  name: string;
}
export interface CoursewareDto {
  id: string;
  name: string;
  size: number;
  category: CoursewareCategory;
  extension: string;
  archiveDate: string;
  sha256: string;
  createdAt: string;
  teacher: { id: string; name: string };
  classes: CoursewareClassDto[];
}
export interface CoursewareUploadRequest {
  name: string;
  size: number;
  classIds: string[];
  mode: 'cloud' | 'push';
}
export interface CoursewarePushDto {
  id: string;
  courseware: CoursewareDto;
}
export interface CoursewareTransfer {
  id: string;
  name: string;
  category: CoursewareCategory;
  teacherName: string;
  receivedBytes: number;
  totalBytes: number;
  progress: number;
  stage: 'downloading' | 'verifying' | 'completed' | 'failed';
  error?: string;
}
