export interface AiAttachment {
  id: string;
  name: string;
  size: number;
  sha256: string;
}
export interface AiOperation {
  action: string;
  target?: Record<string, string>;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  attachmentId?: string;
}
export interface AiCapability {
  action: string;
  label: string;
  kind: 'read' | 'write';
  dangerous: boolean;
  schema: Record<string, unknown>;
  sensitiveFields: string[];
}
export interface AiExecutionRequest {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
  attachmentId?: string;
  sha256?: string;
}
export interface AiPlanStep extends AiOperation {
  id: string;
  label: string;
  status: 'draft' | 'prepared' | 'confirmed' | 'running' | 'succeeded' | 'failed' | 'blocked';
  summary: string;
  dangerous: boolean;
  sensitiveFields: string[];
  before?: unknown;
  preview?: unknown;
  result?: unknown;
  error?: string;
  request?: AiExecutionRequest;
}
export interface AiConversationRequest {
  text: string;
  classId?: string;
  messages?: { role: 'user' | 'assistant'; content: string }[];
  attachments?: AiAttachment[];
}
export interface AiConversationResult {
  planId: string | null;
  message: string;
  steps: AiPlanStep[];
  results: { action: string; label: string; data: unknown }[];
}
