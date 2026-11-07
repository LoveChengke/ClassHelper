import type { AiExecutionRequest } from '@classhelper/shared';

export function allowsAiExecution(action: Pick<AiExecutionRequest, 'method' | 'path'>): boolean {
  if (
    action.path === '/auth/password' ||
    /^\/(?:homeworks|notifications|calls|courseware|classes|courses|students|teachers|grades|class-plans|class-plan-groups|time-layouts|term|archives|permissions|clients|imports|schedules)(?:\/|$)/.test(
      action.path,
    )
  )
    return true;
  if (action.method === 'POST' && ['/update/client/fetch', '/update/client/releases'].includes(action.path))
    return true;
  return (
    action.method === 'DELETE' &&
    /^\/update\/client\/releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(action.path) &&
    !action.path.includes('..')
  );
}
