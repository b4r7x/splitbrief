import type { Task } from '../../../core/schemas/task.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { EventBus } from '../../events/types.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { nowIso } from '../../../utils/format-time.js';
import { publishWarning } from '../events.js';
import { formatBriefReadinessBlocks, writeBriefReadinessOverride } from './brief-readiness-gate.js';
import type { BriefReadinessGateReport } from './brief-readiness-gate.js';

export const MAX_UNPRODUCTIVE_BRIEF_REVIEW_ATTEMPTS = 20;

export const READINESS_OVERRIDE_SENTENCE =
  'Approve again without editing tasks.md to proceed anyway.';

export function briefReviewFingerprint(tasks: Task[], briefsBody: string, detail: string): string {
  const taskSignature = tasks.map((task) => `${task.id}:${task.action}:${task.file}`).join('\n');
  return sha256Hex([taskSignature, briefsBody, detail].join('\n'));
}

export function readinessBlockDetail(report: BriefReadinessGateReport): string {
  return `readiness:${formatBriefReadinessBlocks(report)}`;
}

interface BriefReviewTracker {
  registerFailure: (fingerprint: string) => boolean;
  isOverrideOffered: (fingerprint: string) => boolean;
  offerOverride: (fingerprint: string) => void;
  reset: () => void;
}

export function createBriefReviewTracker(): BriefReviewTracker {
  let overrideOfferedFor: string | undefined;
  let lastFailureFingerprint: string | undefined;
  let unproductiveAttempts = 0;

  return {
    registerFailure: (fingerprint) => {
      if (fingerprint === lastFailureFingerprint) {
        unproductiveAttempts += 1;
      } else {
        lastFailureFingerprint = fingerprint;
        unproductiveAttempts = 1;
      }
      return unproductiveAttempts >= MAX_UNPRODUCTIVE_BRIEF_REVIEW_ATTEMPTS;
    },
    isOverrideOffered: (fingerprint) => fingerprint === overrideOfferedFor,
    offerOverride: (fingerprint) => {
      overrideOfferedFor = fingerprint;
    },
    reset: () => {
      overrideOfferedFor = undefined;
      lastFailureFingerprint = undefined;
      unproductiveAttempts = 0;
    },
  };
}

export function publishReadinessBlockWarning(opts: {
  bus: EventBus;
  phase: Phase;
  report: BriefReadinessGateReport;
}): void {
  publishWarning({
    bus: opts.bus,
    phase: opts.phase,
    message: `${formatBriefReadinessBlocks(opts.report)} ${READINESS_OVERRIDE_SENTENCE}`,
    safety: { category: 'workflow', code: 'brief_readiness_block', transcriptSafe: true },
  });
}

export function recordReadinessOverride(opts: {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  phase: Phase;
  report: BriefReadinessGateReport;
}): void {
  writeBriefReadinessOverride(
    { projectDir: opts.projectDir, sessionId: opts.sessionId },
    opts.report,
    {
      at: nowIso(),
      blockedTaskIds: opts.report.blocks.map((block) => block.taskId),
      kinds: [...new Set(opts.report.blocks.map((block) => block.kind))],
    },
  );
  publishWarning({
    bus: opts.bus,
    phase: opts.phase,
    message: 'Task Brief readiness override recorded; proceeding with the blocked briefs.',
    safety: { category: 'workflow', code: 'brief_readiness_overridden', transcriptSafe: true },
  });
}
