import type { Session } from '../schemas/session.js';
import type { TaskCompletionMethod } from '../schemas/enums.js';
import { assertNever } from '../../utils/type-guards.js';

export interface SessionDisplayColors {
  success: string;
  warning: string;
  error: string;
  textDim: string;
}

export interface SessionStatusDisplay {
  icon: string;
  color: string;
}

export interface MethodDisplay {
  text: string;
  color: string;
}

export function getMethodDisplay(
  method: TaskCompletionMethod,
  theme: SessionDisplayColors,
): MethodDisplay {
  switch (method) {
    case 'local':
      return { text: 'local', color: theme.success };
    case 'escalated-intermediate':
      return { text: 'intermediate', color: theme.warning };
    case 'escalated-hint':
      return { text: 'hint', color: theme.warning };
    case 'escalated-full':
      return { text: 'escalated', color: theme.error };
    case 'failed':
      return { text: 'fail', color: theme.error };
    case 'skipped':
      return { text: 'skip', color: theme.textDim };
    case 'mcp-tool':
      return { text: 'mcp', color: theme.success };
    default:
      return assertNever(method);
  }
}

export function getSessionStatusDisplay(
  status: Session['status'],
  theme: SessionDisplayColors,
): SessionStatusDisplay {
  switch (status) {
    case 'complete':
      return { icon: '\u2713', color: theme.success };
    case 'interrupted':
      return { icon: '\u25cb', color: theme.warning };
    case 'failed':
      return { icon: '\u2717', color: theme.error };
    default:
      return assertNever(status);
  }
}
