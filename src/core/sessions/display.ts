import type { Session } from '../schemas/session.js';
import type { StopKind } from '../schemas/run-step.js';
import type { TaskCompletionMethod } from '../schemas/enums.js';
import { glyph } from '../../lib/glyphs.js';
import { assertNever } from '../../utils/type-guards.js';

export interface SessionDisplayColors {
  accent: string | undefined;
  success: string | undefined;
  warning: string | undefined;
  error: string | undefined;
  textDim: string | undefined;
}

export interface SessionStatusDisplay {
  icon: string;
  color: string | undefined;
  word: string;
}

/** The one word that says how a brief settled. */
export function methodWord(method: TaskCompletionMethod): string {
  switch (method) {
    case 'local':
      return 'passed';
    case 'consulted':
      return 'consulted';
    case 'escalated-intermediate':
      return 'intermediate';
    case 'escalated-hint':
      return 'hint';
    case 'escalated-full':
      return 'escalated';
    case 'failed':
      return 'fail';
    case 'skipped':
      return 'skip';
    default:
      return assertNever(method);
  }
}

const STOP_WORDS: Record<StopKind, string> = {
  'waiting-for-you': 'waiting for you',
  stopped: 'stopped',
};

/** The one word a run's state spells, on every surface that names it. */
export function sessionStatusWord(session: Pick<Session, 'status' | 'stop' | 'apply'>): string {
  if (session.apply === 'ready') return 'ready to apply';
  if (session.apply === 'applied') return 'applied';
  if (session.apply === 'undone') return 'apply undone';
  if (session.apply === 'discarded') return 'discarded';
  switch (session.status) {
    case 'complete':
      return 'complete';
    case 'ended':
      return 'ended';
    case 'open':
      // An open row with no stop reason is a run still going; the stop reason is
      // what a run that came to rest leaves behind.
      return session.stop === undefined ? 'running' : STOP_WORDS[session.stop];
    default:
      return assertNever(session.status);
  }
}

function statusIcon(session: Pick<Session, 'status' | 'stop' | 'apply'>): string {
  if (session.apply === 'ready') return glyph('statusOpen');
  if (session.apply === 'applied') return glyph('stageDone');
  if (session.apply === 'undone' || session.apply === 'discarded') return glyph('statusCancelled');
  switch (session.status) {
    case 'complete':
      return glyph('stageDone');
    case 'ended':
      return glyph('statusCancelled');
    case 'open':
      // The list is static, so a running run takes the table's in-progress mark
      // rather than a spinner frame — at the ascii tier the first line-spinner
      // frame is the same character as the cursor lead.
      return session.stop === undefined ? glyph('statusInProgress') : glyph('statusOpen');
    default:
      return assertNever(session.status);
  }
}

function statusColor(
  session: Pick<Session, 'status' | 'stop' | 'apply'>,
  theme: SessionDisplayColors,
): string | undefined {
  if (session.apply === 'ready') return theme.accent;
  if (session.apply === 'applied') return theme.success;
  if (session.apply === 'undone' || session.apply === 'discarded') return theme.textDim;
  if (session.status === 'complete') return theme.success;
  if (session.status === 'ended') return theme.textDim;
  if (session.stop === undefined) return theme.accent;
  return session.stop === 'waiting-for-you' ? theme.warning : theme.textDim;
}

export function getSessionStatusDisplay(
  session: Pick<Session, 'status' | 'stop' | 'apply'>,
  theme: SessionDisplayColors,
): SessionStatusDisplay {
  return {
    icon: statusIcon(session),
    color: statusColor(session, theme),
    word: sessionStatusWord(session),
  };
}
