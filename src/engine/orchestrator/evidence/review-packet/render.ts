import type { ReviewPacket, ReviewPacketCheckpoint } from '../../../../core/schemas/review-packet.js';
import { CHECKPOINT_RESTORE_SAFETY } from '../../../snapshots/checkpoint-summary.js';
import { narrowRecord } from '../../../../utils/type-guards.js';

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  const record = narrowRecord(value);
  if (!record) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = sortJson(record[key]);
  }
  return sorted;
}

export function stringifyReviewPacket(packet: ReviewPacket): string {
  return `${JSON.stringify(sortJson(packet), null, 2)}\n`;
}

function renderList(items: string[]): string {
  if (items.length === 0) return '- None recorded.';
  return items.map((item) => `- ${item}`).join('\n');
}

function renderReadinessChecks(checks: ReviewPacket['readiness']['checks']): string[] {
  if (checks.length === 0) return ['- Checks: unavailable'];
  return checks.map((check) => `- ${check.severity} ${check.id}: ${check.summary}`);
}

function formatStatus(status: boolean | null): string {
  if (status === true) return 'passed';
  if (status === false) return 'failed';
  return 'unavailable';
}

function formatCheckpointKind(checkpoint: ReviewPacketCheckpoint): string {
  return checkpoint.inferredKind
    ? `${checkpoint.kind} (inferred ${checkpoint.inferredKind})`
    : checkpoint.kind;
}

function formatReviewPacketActualCost(costBreakdown: ReviewPacket['cost']['costBreakdown']): string {
  if (!costBreakdown) return 'unavailable';
  if (costBreakdown.isTotalActualCostKnown === false) {
    return costBreakdown.totalActualCost > 0
      ? `$${costBreakdown.totalActualCost.toFixed(4)} + unknown`
      : 'unavailable';
  }
  return `$${costBreakdown.totalActualCost.toFixed(4)}`;
}

export function renderReviewPacketMarkdown(packet: ReviewPacket): string {
  const restoreSafety = packet.checkpoints.items[0]?.safety ?? CHECKPOINT_RESTORE_SAFETY;
  const checkpointLines = packet.checkpoints.items.length === 0
    ? ['- No checkpoints available.']
    : packet.checkpoints.items.map((checkpoint) =>
      `- ${checkpoint.id}${checkpoint.name ? ` (${checkpoint.name})` : ''}: ${formatCheckpointKind(checkpoint)}, ${checkpoint.trackedFileCount} files, diff \`${checkpoint.diffCommand}\`, restore \`${checkpoint.restoreCommand}\``
    );
  const driftLines = packet.drift.findings.length === 0
    ? ['- No drift findings recorded.']
    : packet.drift.findings.map((finding) => `- [${finding.severity}] ${finding.code}: ${finding.message}`);
  const recoveryLines = packet.recoveryDecisions.outcomes.length === 0
    ? ['- No recovery decisions recorded.']
    : packet.recoveryDecisions.outcomes.map((outcome) =>
      `- ${outcome.status}${outcome.action ? ` via ${outcome.action}` : ''}${outcome.issueId ? ` (${outcome.issueId})` : ''}${outcome.message ? `: ${outcome.message}` : ''}`
    );
  const taskValidationLines = packet.validation.tasks.map((task) =>
    `- ${task.taskId} ${task.status}: ${task.validation.filter((entry) => entry.passed).length}/${task.validation.length} validation stages passed`
  );

  return [
    '# Review Packet',
    '',
    '## Run Header',
    `- Session: ${packet.sessionId}`,
    `- Feature: ${packet.run.feature}`,
    `- Mode: ${packet.run.mode ?? 'n/a'}`,
    `- Planner: ${packet.run.planner.tool ?? 'n/a'}${packet.run.planner.model ? ` (${packet.run.planner.model})` : ''}`,
    `- Implementer: ${packet.run.implementer.tool ?? 'n/a'}${packet.run.implementer.model ? ` (${packet.run.implementer.model})` : ''}`,
    `- Tasks: ${packet.run.totalTasks} total, ${packet.run.completedLocally} local, ${packet.run.escalated} escalated, ${packet.run.skipped} skipped, ${packet.run.failed} failed`,
    `- Generated: ${packet.generatedAt}`,
    '',
    '## Readiness',
    `- Artifact: ${packet.readiness.present ? packet.readiness.path : 'missing'}`,
    `- Status: ${packet.readiness.status ?? 'unavailable'}`,
    `- Next action: ${packet.readiness.nextAction ?? 'unavailable'}`,
    `- Blockers: ${packet.readiness.blockerCount ?? 'unavailable'}`,
    `- Warnings: ${packet.readiness.warningCount ?? 'unavailable'}`,
    ...renderReadinessChecks(packet.readiness.checks),
    '',
    '## Change Summary',
    renderList(packet.changes.changedFiles),
    `- Expected files: ${packet.changes.expectedFiles.length}`,
    `- Out-of-scope files: ${packet.changes.outOfScopeFiles.length}`,
    `- Diff: ${packet.changes.diffReference}`,
    '',
    '## Checkpoints And Restore',
    ...checkpointLines,
    `- Latest run checkpoint: ${packet.checkpoints.latestRunCheckpoint?.id ?? 'none'}`,
    `- Pre-final-review checkpoint: ${packet.checkpoints.preFinalReview?.id ?? 'none'}`,
    `- Restore safety: ${restoreSafety.text.hashGuarded}`,
    `- Restore safety: ${restoreSafety.text.conflictsSkippedByDefault}`,
    `- Restore safety: ${restoreSafety.text.forceOverwritesConflicts}`,
    `- Restore safety: ${restoreSafety.text.partialRestoreExpected}`,
    `- Restore safety: ${restoreSafety.text.excludedPaths}`,
    `- Excluded paths: ${restoreSafety.excludedPaths.join(', ')}`,
    '',
    '## Validation And Evidence',
    `- Validation: ${packet.validation.summary.passed} passed, ${packet.validation.summary.failed} failed, ${packet.validation.summary.skipped} skipped, ${packet.validation.summary.escalated} escalated`,
    `- Evidence ledger: ${packet.evidence.present ? packet.evidence.path : 'missing'}`,
    ...taskValidationLines,
    '',
    '## Drift And Scope',
    `- Drift: ${formatStatus(packet.drift.passed)}${packet.drift.score === null ? '' : `, score ${packet.drift.score.toFixed(2)}`}`,
    ...driftLines,
    '',
    '## Escalations, Retries, Skips, And Warnings',
    `- Retries: ${packet.escalations.retries.length}`,
    `- Escalated tasks: ${packet.escalations.escalatedTasks.length}`,
    `- Skipped tasks: ${packet.escalations.skippedTasks.length}`,
    `- Failed tasks: ${packet.escalations.failedTasks.length}`,
    `- Warnings: ${packet.escalations.warnings.length}`,
    '',
    '## Recovery Decisions',
    ...recoveryLines,
    ...packet.recoveryDecisions.unresolvedRisks.map((risk) => `- Risk: ${risk}`),
    '',
    '## Cost And Routing',
    `- Actual cost: ${formatReviewPacketActualCost(packet.cost.costBreakdown)}`,
    `- Estimated savings: ${packet.cost.estimatedCostSavings ?? 'unavailable'}`,
    `- Per-task routing entries: ${packet.cost.taskRouting.length}`,
    '',
    '## Planner Final Review',
    `- Status: ${packet.finalReview.status}`,
    `- Path: ${packet.finalReview.path}`,
    `- ${packet.finalReview.statusText}`,
    ...(packet.finalReview.excerpt ? [`- Excerpt: ${packet.finalReview.excerpt}`] : []),
    '',
    '## Human Reviewer Checklist',
    ...packet.reviewerChecklist.map((item) => `- [ ] ${item}`),
    '',
    '## Missing Artifacts',
    renderList(packet.missingArtifacts),
    '',
  ].join('\n');
}
