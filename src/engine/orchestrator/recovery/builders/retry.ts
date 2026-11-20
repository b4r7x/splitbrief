import { HAND_BACK_PANEL_CHARS } from '../../../../core/pipeline-spec/ladder.js';
import { retryExhaustedCause, cannotDetail } from '../../../../core/recovery/causes.js';
import type { CannotNextStep } from '../../../../core/schemas/consult.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import { sanitizeTerminalDisplayText } from '../../../../utils/display-text/sanitize.js';
import { haltActions, chooseRecommended } from './actions.js';
import { summarizeValidation, taskFiles, attemptDetails } from './details.js';
import {
  compactFacts,
  createRecoveryIssue,
  type RecoveryBuilderBase,
  type TaskRecoveryContext,
} from './issue.js';

export interface ValidationRecoveryOptions extends RecoveryBuilderBase, TaskRecoveryContext {
  validationSummary?: string | undefined;
}

export interface RetryExhaustedRecoveryOptions extends ValidationRecoveryOptions {
  allowRetryOverride?: boolean | undefined;
  /** The `pre_escalation` hook's reason when the hook stopped the ladder before its tiers. */
  escalationBlockedBy?: string | undefined;
  handBack?: string | undefined;
  /** The planner's question nobody answered: only the operator can move the brief on. */
  question?: string | undefined;
  /** The planner's reason why the brief cannot be done. */
  cannot?: string | undefined;
  /** The step the planner named for a `cannot` when the user is not asked. */
  cannotNext?: CannotNextStep | null | undefined;
}

/** The error a retry-exhausted brief stopped on; a denial or a no-change message is not a check result. */
function lastErrorDetail(validation: ReturnType<typeof summarizeValidation>): string {
  return `Last error: ${validation.summary}`;
}

/** The end of a hand-back, where an implementer that stopped says why. */
function handBackQuote(handBack: string): string {
  const masked = sanitizeTerminalDisplayText(handBack, { preserveLineBreaks: true });
  const collapsed = masked.trim().replace(/\s+/g, ' ');
  return collapsed.length <= HAND_BACK_PANEL_CHARS
    ? collapsed
    : `…${collapsed.slice(collapsed.length - HAND_BACK_PANEL_CHARS)}`;
}

export function buildRetryExhaustedRecoveryIssue(
  opts: RetryExhaustedRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'escalating';
  const validation = summarizeValidation(opts);
  const cannotBy = opts.cannot === undefined ? undefined : 'planner';
  const actions = haltActions('retry-exhausted', [
    opts.allowRetryOverride ? 'retry-same-worker' : undefined,
    opts.cannot === undefined && opts.question !== undefined ? 'decide-for-me' : undefined,
    'skip-current-task',
    'end-run',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'retry-exhausted',
    phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: retryExhaustedCause({
      task: opts.task.id,
      hookReason: opts.escalationBlockedBy,
      question: opts.question,
      cannotBy,
    }),
    details: [
      ...(opts.question !== undefined ? [`Question: ${opts.question}`] : []),
      ...(opts.cannot === undefined ? [] : [cannotDetail('planner', opts.cannot)]),
      lastErrorDetail(validation),
      ...(opts.attempts === 0 ? [] : attemptDetails(opts.attempts)),
      ...(opts.handBack ? [`Implementer said: ${handBackQuote(opts.handBack)}`] : []),
    ],
    selectedImplementerProfile: opts.selectedImplementerProfile,
    facts: compactFacts({
      validationSummary: validation.summary,
      allowRetryOverride: opts.allowRetryOverride,
      escalationBlockedBy: opts.escalationBlockedBy,
      question: opts.question,
      cannot: opts.cannot,
      cannotBy,
      cannotNext: opts.cannotNext ?? undefined,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(
      actions,
      opts.cannot === undefined
        ? []
        : [opts.cannotNext === 'end-run' ? 'end-run' : 'skip-current-task'],
    ),
    createdAt: opts.createdAt,
  });
}
