import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ReviewPacket,
  ReviewPacketCheckpoint,
} from '../../../../core/schemas/review-packet.js';
import {
  RECOVERY_ACTIONS,
  RECOVERY_REASONS,
  type RecoveryAction,
  type RecoveryReason,
} from '../../../../core/schemas/enums.js';
import { TaskIdSchema, type TaskId } from '../../../../core/schemas/task.js';
import {
  BRIEF_QUALITY_FILE,
  READINESS_FILE,
  SESSION_LOG_FILE,
  SNAPSHOTS_DIR,
  sessionDir,
} from '../../../../core/paths.js';
import { readEvents } from '../../../../core/sessions/log-reader.js';
import { readJsonSafe } from '../../../../lib/fs.js';
import { includes, narrowRecord, optionalString } from '../../../../utils/type-guards.js';
import {
  listCheckpointSummaries,
  type CheckpointSummary,
} from '../../../snapshots/checkpoint-summary.js';
import { readRunSnapshotLedger } from '../../../snapshots/run.js';
import { addMissing } from './missing-artifacts.js';
import type { BriefQualityArtifact, PacketEvent } from './types.js';

const RUN_LEDGER_PATH = `${SNAPSHOTS_DIR}/run-ledger.json`;

function recoveryReason(value: unknown): RecoveryReason | undefined {
  return includes(RECOVERY_REASONS, value) ? value : undefined;
}

function recoveryAction(value: unknown): RecoveryAction | undefined {
  return includes(RECOVERY_ACTIONS, value) ? value : undefined;
}

function recoveryActions(value: unknown): RecoveryAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions = value.filter((entry): entry is RecoveryAction =>
    includes(RECOVERY_ACTIONS, entry),
  );
  return actions.length > 0 ? actions : undefined;
}

function taskIds(value: unknown): TaskId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: TaskId[] = [];
  for (const entry of value) {
    const parsed = TaskIdSchema.safeParse(entry);
    if (parsed.success) ids.push(parsed.data);
  }
  return ids.length > 0 ? ids : undefined;
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((entry): entry is string => typeof entry === 'string');
  return values.length > 0 ? values : undefined;
}

export function readBriefQuality(
  projectDir: string,
  sessionId: string,
  missing: string[],
): BriefQualityArtifact | null {
  const target = join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE);
  const raw = readJsonSafe(target);
  if (raw === null) {
    addMissing(missing, BRIEF_QUALITY_FILE);
    return null;
  }

  const record = narrowRecord(raw);
  if (
    !record ||
    record.version !== 1 ||
    typeof record.passed !== 'boolean' ||
    typeof record.score !== 'number'
  ) {
    addMissing(missing, BRIEF_QUALITY_FILE);
    return null;
  }

  const rawIssues = Array.isArray(record.issues) ? record.issues : [];
  const issues: BriefQualityArtifact['issues'] = [];
  for (const rawIssue of rawIssues) {
    const issue = narrowRecord(rawIssue);
    if (!issue) continue;
    const severity =
      issue.severity === 'error' || issue.severity === 'warning' ? issue.severity : undefined;
    const message = optionalString(issue.message);
    if (severity && message) issues.push({ severity, message });
  }

  return {
    version: 1,
    passed: record.passed,
    score: record.score,
    issues,
  };
}

function nonnegativeIntegerOrNull(value: unknown): number | null {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0 ? value : null;
}

const READINESS_NEXT_ACTIONS = [
  'continue',
  'run-init',
  'fix-config',
  'clean-or-isolate-repo',
  'raise-context',
  'set-budget',
  'exit',
] as const;

function recoveryReadinessAction(value: unknown): ReviewPacket['readiness']['nextAction'] {
  return includes(READINESS_NEXT_ACTIONS, value) ? value : null;
}

function readinessChecks(value: unknown): ReviewPacket['readiness']['checks'] {
  if (!Array.isArray(value)) return [];
  const checks: ReviewPacket['readiness']['checks'] = [];
  for (const rawCheck of value) {
    const check = narrowRecord(rawCheck);
    if (!check) continue;
    const id = optionalString(check.id);
    const summary = optionalString(check.summary);
    const severity =
      check.severity === 'ok' ||
      check.severity === 'info' ||
      check.severity === 'warning' ||
      check.severity === 'blocker'
        ? check.severity
        : undefined;
    if (id && severity && summary) checks.push({ id, severity, summary });
  }
  return checks;
}

export function readReadinessArtifact(
  projectDir: string,
  sessionId: string,
): Record<string, unknown> | null {
  const target = join(sessionDir(projectDir, sessionId), READINESS_FILE);
  const raw = readJsonSafe(target);
  if (raw === null) return null;
  const record = narrowRecord(raw);
  if (!record || record.type !== 'start-readiness') return null;
  return record;
}

export function readReadiness(
  projectDir: string,
  sessionId: string,
  missing: string[],
): ReviewPacket['readiness'] {
  const record = readReadinessArtifact(projectDir, sessionId);
  if (!record) {
    addMissing(missing, READINESS_FILE);
    return {
      path: READINESS_FILE,
      present: false,
      status: null,
      nextAction: null,
      blockerCount: null,
      warningCount: null,
      checks: [],
    };
  }

  return {
    path: READINESS_FILE,
    present: true,
    status:
      record.status === 'ready' ||
      record.status === 'ready-with-warnings' ||
      record.status === 'blocked'
        ? record.status
        : null,
    nextAction: recoveryReadinessAction(record.nextAction),
    blockerCount: nonnegativeIntegerOrNull(record.blockerCount),
    warningCount: nonnegativeIntegerOrNull(record.warningCount),
    checks: readinessChecks(record.checks),
  };
}

export async function readPacketEvents(
  projectDir: string,
  sessionId: string,
  missing: string[],
): Promise<PacketEvent[]> {
  const target = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
  if (!existsSync(target)) {
    addMissing(missing, SESSION_LOG_FILE);
    return [];
  }

  const events: PacketEvent[] = [];
  for await (const entry of readEvents({ projectDir: projectDir, sessionId: sessionId })) {
    const data = narrowRecord(entry.data) ?? {};
    const reason = recoveryReason(data.reason);
    const action = recoveryAction(data.action);
    const files = strings(data.files);
    const affectedTaskIds = taskIds(data.affectedTaskIds);
    const availableActions = recoveryActions(data.availableActions);
    const recommendedAction = recoveryAction(data.recommendedAction);
    const message =
      optionalString(data.message) ??
      optionalString(data.error) ??
      optionalString(data.reason) ??
      optionalString(data.routingReason);
    const outcome = optionalString(data.outcome) ?? optionalString(data.contextFit);
    const event: PacketEvent = {
      ts: entry.ts,
      type: entry.type,
      phase: entry.phase,
      ...(entry.taskId !== undefined && { taskId: entry.taskId }),
      ...(optionalString(data.issueId) !== undefined && { issueId: optionalString(data.issueId) }),
      ...(reason !== undefined && { reason }),
      ...(files !== undefined && { files }),
      ...(affectedTaskIds !== undefined && { affectedTaskIds }),
      ...(availableActions !== undefined && { availableActions }),
      ...(recommendedAction !== undefined && { recommendedAction }),
      ...(action !== undefined && { action }),
      ...(outcome !== undefined && { outcome }),
      ...(message !== undefined && { message }),
    };
    events.push(event);
  }
  return events;
}

function toReviewPacketCheckpoint(checkpoint: CheckpointSummary): ReviewPacketCheckpoint {
  return {
    ...checkpoint,
    safety: {
      ...checkpoint.safety,
      excludedPaths: [...checkpoint.safety.excludedPaths],
      text: { ...checkpoint.safety.text },
    },
  };
}

export async function readCheckpoints(
  projectDir: string,
  sessionId: string,
  missing: string[],
): Promise<ReviewPacket['checkpoints']> {
  let items: ReviewPacketCheckpoint[] = [];
  try {
    items = (await listCheckpointSummaries(projectDir, sessionId)).map(toReviewPacketCheckpoint);
  } catch {
    addMissing(missing, SNAPSHOTS_DIR);
  }

  const ledger = await readRunSnapshotLedger(projectDir, sessionId);
  if (!ledger) addMissing(missing, RUN_LEDGER_PATH);

  const latestRunCheckpointId = ledger?.runSnapshotIds.at(-1) ?? null;
  const latestRunCheckpoint = latestRunCheckpointId
    ? (items.find((checkpoint) => checkpoint.id === latestRunCheckpointId) ?? null)
    : null;
  const preFinalReview =
    items.filter((checkpoint) => checkpoint.kind === 'pre-final-review').at(-1) ?? null;

  return {
    items,
    latestRunCheckpoint,
    preFinalReview,
    runLedger: {
      path: RUN_LEDGER_PATH,
      present: ledger !== null,
      accepted: ledger?.accepted ?? null,
      rejected: ledger?.rejected ?? null,
      runSnapshotIds: ledger?.runSnapshotIds ?? [],
      runSnapshotKinds: ledger?.runSnapshotKinds ?? {},
      latestSnapshotId: latestRunCheckpointId,
    },
  };
}
