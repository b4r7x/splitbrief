import type {
  ReviewPacket,
  ReviewPacketCheckpoint,
} from '../../../../core/schemas/review-packet.js';
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

function renderChecksLog(checks: ReviewPacket['checks']): string[] {
  const entryLines = checks.entries.flatMap((entry) => {
    const task = entry.taskId === undefined ? '' : ` ${entry.taskId}`;
    const exit = entry.exitCode === undefined ? '' : ` (exit ${entry.exitCode})`;
    const command = entry.command === undefined ? '' : `: ${entry.command}`;
    const lines = [`- ${entry.id}${task}${exit}${command}`];
    for (const line of (entry.output ?? '').split('\n')) {
      if (line.trim() !== '') lines.push(`  output: ${line}`);
    }
    if (entry.preExisting !== undefined && entry.preExisting.length > 0) {
      lines.push(`  pre-existing (also red at the run base): ${entry.preExisting.join(', ')}`);
    }
    for (const artifact of entry.artifacts ?? []) {
      lines.push(`  artifact: ${artifact.path} sha256 ${artifact.sha256}`);
    }
    if (entry.workspaceSnapshotId !== undefined) {
      lines.push(`  snapshot: ${entry.workspaceSnapshotId}`);
    }
    if (entry.ts !== undefined) lines.push(`  time: ${entry.ts}`);
    return lines;
  });
  const outsideReadLines = checks.outsideReadPaths.map((path) => `- outside read: ${path}`);
  if (entryLines.length === 0 && outsideReadLines.length === 0) return ['- No checks recorded.'];
  return [...entryLines, ...outsideReadLines];
}

export function renderWholeChecksLog(checks: ReviewPacket['checks']): string {
  return renderChecksLog(checks).join('\n');
}

const DETAIL_CHAR_CAP = 800;
const SECTION_CHAR_CAP = 30_000;

function capDetailTail(detail: string): string {
  const trimmed = detail.trim();
  if (trimmed.length <= DETAIL_CHAR_CAP) return trimmed;
  return `…${trimmed.slice(-(DETAIL_CHAR_CAP - 1))}`;
}

export function renderChecksLogForPrompt(
  checks: ReviewPacket['checks'],
  paths: Readonly<{ validation: string; sessionLog: string }>,
): string {
  const latest = new Map<string, { index: number; ts: string | undefined }>();
  checks.entries.forEach((entry, index) => {
    const previous = latest.get(entry.id);
    if (
      previous === undefined ||
      previous.ts === undefined ||
      entry.ts === undefined ||
      entry.ts >= previous.ts
    ) {
      latest.set(entry.id, { index, ts: entry.ts });
    }
  });
  const blocks = [
    ...checks.entries.map((entry, index) => {
      const failed = entry.exitCode !== undefined && entry.exitCode !== 0;
      return {
        priority: latest.get(entry.id)?.index === index ? (failed ? 1 : 2) : failed ? 3 : 4,
        text: renderChecksLog({
          entries: [
            {
              ...entry,
              ...(entry.output !== undefined && { output: capDetailTail(entry.output) }),
            },
          ],
          outsideReadPaths: [],
        }).join('\n'),
      };
    }),
    ...checks.outsideReadPaths.map((path) => ({
      priority: 0,
      text: renderChecksLog({ entries: [], outsideReadPaths: [path] }).join('\n'),
    })),
  ];
  if (blocks.length === 0) return renderWholeChecksLog(checks);
  const whole = blocks.map((block) => block.text).join('\n');
  if (whole.length <= SECTION_CHAR_CAP) return whole;
  const omissionMarker = (omitted: number, outsideReadOmitted: boolean): string =>
    `[… ${omitted} entries omitted for size; the whole log is in ${paths.validation}${
      outsideReadOmitted ? `, the isolation_outside_read warnings in ${paths.sessionLog}` : ''
    } …]`;
  const markerChars = omissionMarker(blocks.length, checks.outsideReadPaths.length > 0).length;
  const byPriority = blocks
    .map((block, index) => ({ ...block, index }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index);
  const included = new Set<number>();
  let chars = 0;
  for (const block of byPriority) {
    if (chars + block.text.length + 1 + markerChars > SECTION_CHAR_CAP) continue;
    included.add(block.index);
    chars += block.text.length + 1;
  }
  const lines = blocks.filter((_, index) => included.has(index)).map((block) => block.text);
  if (included.size < blocks.length) {
    const outsideReadOmitted = blocks.some(
      (block, index) => block.priority === 0 && included.has(index) === false,
    );
    lines.push(omissionMarker(blocks.length - included.size, outsideReadOmitted));
  }
  return lines.join('\n');
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

export function renderReviewPacketMarkdown(packet: ReviewPacket): string {
  const restoreSafety = packet.checkpoints.safety;
  const checkpointLines =
    packet.checkpoints.items.length === 0
      ? ['- No checkpoints available.']
      : packet.checkpoints.items.map(
          (checkpoint) =>
            `- ${checkpoint.id}${checkpoint.name ? ` (${checkpoint.name})` : ''}: ${formatCheckpointKind(checkpoint)}, ${checkpoint.trackedFileCount} files`,
        );
  const driftLines =
    packet.drift.findings.length === 0
      ? ['- No drift findings recorded.']
      : packet.drift.findings.map(
          (finding) => `- [${finding.severity}] ${finding.code}: ${finding.message}`,
        );
  const recoveryLines =
    packet.recoveryDecisions.outcomes.length === 0
      ? ['- No recovery decisions recorded.']
      : packet.recoveryDecisions.outcomes.map(
          (outcome) =>
            `- ${outcome.status}${outcome.action ? ` via ${outcome.action}` : ''}${outcome.issueId ? ` (${outcome.issueId})` : ''}${outcome.message ? `: ${outcome.message}` : ''}`,
        );
  const taskValidationLines = packet.validation.tasks.map((task) => {
    const passed = task.validation.filter((entry) => entry.passed).length;
    const exempt = task.validation.filter((entry) => entry.baselineExempt === true);
    const base = `- ${task.taskId} ${task.status}: ${passed}/${task.validation.length} validation stages passed`;
    if (exempt.length === 0) return base;
    const stages = exempt.map((entry) => entry.stage).join(', ');
    return `${base} (${exempt.length} baseline-exempt: ${stages})`;
  });

  return [
    '# Review Packet',
    '',
    '## Run Header',
    `- Session: ${packet.sessionId}`,
    `- Feature: ${packet.run.feature}`,
    `- Planner: ${packet.run.planner.tool ?? 'n/a'}${packet.run.planner.model ? ` (${packet.run.planner.model})` : ''}`,
    `- Implementer: ${packet.run.implementer.tool ?? 'n/a'}${packet.run.implementer.model ? ` (${packet.run.implementer.model})` : ''}`,
    `- Reviewer: ${packet.run.reviewer?.tool ?? 'n/a'}${packet.run.reviewer?.model ? ` (${packet.run.reviewer.model})` : ''}`,
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
    `- Changed outside every brief's files: ${packet.changes.outOfScopeFiles.length}`,
    `- Diff: ${packet.changes.diffReference}`,
    ...(packet.changes.provenance === undefined
      ? []
      : [
          `- Promotion evidence: ${packet.changes.provenance.status} (${packet.changes.provenance.path}).`,
          `- Recorded run effects: ${packet.changes.provenance.promotedFiles.join(', ') || 'none recorded'}.`,
          `- Workspace context: ${packet.changes.provenance.workspaceFiles.join(', ') || 'none'}.`,
          `- Uncertain attribution or later edits: ${packet.changes.provenance.uncertainFiles.join(', ') || 'none observed'}.`,
          '- Workspace changes alone do not establish implementer authorship. Review mixed and uncertain edits against the recorded promotions and current behavior.',
        ]),
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
    '## Checks Log',
    ...renderChecksLog(packet.checks),
    '',
    '## Drift And Scope',
    `- Drift: ${formatStatus(packet.drift.passed)}`,
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
    '## Routing',
    `- Per-task routing entries: ${packet.cost.taskRouting.length}`,
    '',
    '## Reviewer Final Review',
    `- Status: ${packet.finalReview.status}`,
    `- Verdict: ${packet.finalReview.verdict ?? 'unknown'}`,
    `- Criteria: ${packet.finalReview.criteriaPassed} passed, ${packet.finalReview.criteriaFailed} failed`,
    `- Findings: ${packet.finalReview.findingCounts.critical} critical, ${packet.finalReview.findingCounts.warning} warning, ${packet.finalReview.findingCounts.note} note`,
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
