import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../../../../core/schemas/workflow.js';
import type { EvidenceLedger } from '../../../../core/schemas/evidence.js';
import type { RecoveryAction } from '../../../../core/schemas/enums.js';
import type { ReviewPacket } from '../../../../core/schemas/review-packet.js';
import { EVIDENCE_FILE, SESSION_LOG_FILE, STATE_FILE, sessionDir } from '../../../../core/paths.js';
import type { PacketEvent } from './types.js';

type RecoveryWithoutSources = Omit<ReviewPacket['recoveryDecisions'], 'sourceArtifacts'>;
type RecoveryOutcome = ReviewPacket['recoveryDecisions']['outcomes'][number];
type RecoverySelectedAction = ReviewPacket['recoveryDecisions']['selectedActions'][number];

const RECOVERY_RESOLVED_STATUS: Record<string, RecoveryOutcome['status']> = {
  'skipped-current-task': 'skipped',
  aborted: 'aborted',
  continued: 'continued',
  'retry-current-task': 'retry-current-task',
};

export interface MakeRecoveryWithSourcesOptions {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  events: PacketEvent[];
  ledger: EvidenceLedger | null;
  missing: string[];
}

function recoveryIssueSummary(
  state: WorkflowState,
): ReviewPacket['recoveryDecisions']['currentIssue'] {
  const issue = state.pendingRecovery;
  if (!issue) return null;
  return {
    issueId: issue.id,
    reason: issue.reason,
    status: issue.status,
    phase: issue.phase,
    ...(issue.taskId !== undefined && { taskId: issue.taskId }),
    ...(issue.selectedAction !== undefined && { selectedAction: issue.selectedAction }),
    recommendedAction: issue.recommendedAction,
    availableActions: issue.availableActions,
    files: issue.files,
    affectedTaskIds: issue.affectedTaskIds,
  };
}

function buildRecovery(
  state: WorkflowState,
  events: PacketEvent[],
  missing: string[],
): RecoveryWithoutSources {
  const recoveryEvents = events.filter((event) => event.type.startsWith('recovery_'));
  const selectedActions: RecoverySelectedAction[] = recoveryEvents
    .filter(
      (event) =>
        event.type === 'recovery_action_selected' && event.issueId && event.reason && event.action,
    )
    .map((event) => ({
      issueId: event.issueId ?? '',
      reason: event.reason ?? 'implementation-error',
      action: (event.action ?? 'pause-run') satisfies RecoveryAction,
      selectedAt: event.ts,
    }));

  const resolvedOutcomes: RecoveryOutcome[] = recoveryEvents
    .filter((event) => event.type === 'recovery_resolved')
    .map((event) => {
      const status = RECOVERY_RESOLVED_STATUS[event.outcome ?? ''] ?? 'unresolved';
      return {
        issueId: event.issueId ?? null,
        ...(event.action !== undefined && { action: event.action }),
        status,
      };
    });

  const failedOutcomes: RecoveryOutcome[] = recoveryEvents
    .filter((event) => event.type === 'recovery_action_failed')
    .map((event) => ({
      issueId: event.issueId ?? null,
      ...(event.action !== undefined && { action: event.action }),
      status: 'failed',
      ...(event.message !== undefined && { message: event.message }),
    }));

  const resolvedIssueIds = new Set(
    resolvedOutcomes.flatMap((outcome) => (outcome.issueId ? [outcome.issueId] : [])),
  );
  const pausedOutcomes: RecoveryOutcome[] = selectedActions
    .filter(
      (selected) => selected.action === 'pause-run' && !resolvedIssueIds.has(selected.issueId),
    )
    .map((selected) => ({
      issueId: selected.issueId,
      action: selected.action,
      status: 'paused',
    }));

  const resumedOutcomes: RecoveryOutcome[] = events
    .filter((event) => event.type === 'workflow_resumed')
    .map(() => ({
      issueId: null,
      status: 'resumed',
    }));

  const currentIssue = recoveryIssueSummary(state);
  const unresolvedOutcomes: RecoveryOutcome[] = currentIssue
    ? [
        {
          issueId: currentIssue.issueId,
          ...(currentIssue.selectedAction !== undefined && { action: currentIssue.selectedAction }),
          status: 'unresolved',
          message: `${currentIssue.reason} recovery issue is still ${currentIssue.status}`,
        },
      ]
    : [];

  const unresolvedRisks = [
    ...failedOutcomes.map(
      (outcome) =>
        `Recovery action failed${outcome.issueId ? ` for ${outcome.issueId}` : ''}${outcome.message ? `: ${outcome.message}` : ''}.`,
    ),
    ...pausedOutcomes.map(
      (outcome) =>
        `Recovery issue ${outcome.issueId ?? 'unknown'} paused without a resolved event.`,
    ),
    ...unresolvedOutcomes.map((outcome) => outcome.message ?? 'Recovery issue remains unresolved.'),
  ];

  if (missing.includes(SESSION_LOG_FILE)) {
    unresolvedRisks.push('Recovery events are unavailable because session.jsonl is missing.');
  }

  return {
    events: recoveryEvents,
    currentIssue,
    selectedActions,
    outcomes: [
      ...resolvedOutcomes,
      ...failedOutcomes,
      ...pausedOutcomes,
      ...resumedOutcomes,
      ...unresolvedOutcomes,
    ],
    unresolvedRisks,
  };
}

export function makeRecoveryWithSources(
  opts: MakeRecoveryWithSourcesOptions,
): ReviewPacket['recoveryDecisions'] {
  const recovery = buildRecovery(opts.state, opts.events, opts.missing);
  return {
    ...recovery,
    sourceArtifacts: [
      {
        path: STATE_FILE,
        present: existsSync(join(sessionDir(opts.projectDir, opts.sessionId), STATE_FILE)),
      },
      {
        path: SESSION_LOG_FILE,
        present: existsSync(join(sessionDir(opts.projectDir, opts.sessionId), SESSION_LOG_FILE)),
      },
      { path: EVIDENCE_FILE, present: opts.ledger !== null },
    ],
  };
}
