import { formatShellArgv } from '../../utils/shell-quote.js';

export function formatDetachedAttachHint(projectDir: string, sessionId: string): string {
  return formatShellArgv(['diptych', 'attach', sessionId, '--project', projectDir]);
}
