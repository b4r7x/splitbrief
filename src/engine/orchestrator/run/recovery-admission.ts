import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type {
  BriefAdmissionInput,
  BriefContinuationV1,
  BriefQualityIssue,
  BriefRecoveryOrigin,
} from '../../../core/schemas/brief-recovery.js';
import type { BriefOwnerCommitInput } from '../../../core/schemas/brief-owner.js';
import { BRIEF_QUALITY_FILE, TASKS_FILE } from '../../../core/paths.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { narrowRecord } from '../../../utils/type-guards.js';
import { formatTasks } from '../../spec/formatter.js';
import { evaluateBriefQuality } from '../../spec/brief-quality.js';
import {
  BRIEF_QUALITY_RULE_VERSION,
  briefQualityReportBytes,
} from '../../spec/brief-quality-file.js';
import { workflowStateRevision } from '../state-ops.js';
import type { WorkflowContext } from '../types.js';

type AdmissionContext = Readonly<{
  state: WorkflowState;
  tasks: WorkflowState['tasks'];
  origin?: BriefRecoveryOrigin | undefined;
  continuation?: BriefContinuationV1 | undefined;
}>;

/**
 * The in-memory admission content a later owner commit projects to the
 * fixed-name compatibility files; it must not touch those files before the
 * commit CAS.
 */
export type AdmissionProjection = Readonly<{
  text: string;
  briefHash: string;
  issues: readonly BriefQualityIssue[];
}>;

function continuationFor(mode: WorkflowState['mode']): BriefContinuationV1 {
  if (mode === 'instant') return { version: 1, kind: 'instant-start', entry: 'initial' };
  if (mode === 'quick') return { version: 1, kind: 'quick-start', entry: 'initial' };
  return {
    version: 1,
    kind: 'approval',
    mode: mode === 'speckit' ? 'speckit' : 'standard',
    entry: 'initial',
  };
}

function originFor(mode: WorkflowState['mode']): BriefRecoveryOrigin {
  return { mode: mode ?? 'standard', entry: 'initial' };
}

export function admissionInput(
  wctx: WorkflowContext,
  input: AdmissionContext,
): { input: BriefAdmissionInput; projection: AdmissionProjection } {
  const generated = formatTasks(input.tasks);
  const briefHash = sha256Hex(generated);
  const issues: BriefQualityIssue[] = evaluateBriefQuality(input.tasks).issues.map((issue) => ({
    ...issue,
    taskId: issue.taskId,
  }));
  const reportBody = briefQualityReportBytes({ issues, briefHash });
  const revision = workflowStateRevision(input.state);
  const mode = input.state.mode ?? wctx.config.workflow.mode ?? 'standard';
  return {
    input: {
      sessionId: wctx.sessionId,
      origin: input.origin ?? originFor(mode),
      continuation: input.continuation ?? continuationFor(mode),
      activeBrief: { revision, hash: briefHash, path: TASKS_FILE },
      report: {
        briefHash,
        report: {
          revision,
          hash: sha256Hex(reportBody),
          path: BRIEF_QUALITY_FILE,
        },
        ruleVersion: BRIEF_QUALITY_RULE_VERSION,
        issues,
        errorCount: issues.filter((issue) => issue.severity === 'error').length,
      },
      qualityPolicyVersion: BRIEF_QUALITY_RULE_VERSION,
    },
    projection: { text: generated, briefHash, issues },
  };
}

/**
 * Stage the admitted brief as a planner candidate and its quality report on
 * the admission owner commit, so projectCommittedEvidence refreshes
 * the fixed-name compatibility files only from the committed evidence.
 */
export function withAdmissionProjection(
  input: BriefOwnerCommitInput,
  projection: AdmissionProjection | null,
): BriefOwnerCommitInput {
  const audit = narrowRecord(input.evidence.payload);
  if (audit?.kind !== 'brief-admission' || projection === null) return input;
  const candidate = { kind: 'planner-candidate', text: projection.text };
  const report = {
    kind: 'planner-report',
    briefHash: projection.briefHash,
    issues: projection.issues,
  };
  const candidateHash = sha256Hex(projection.text);
  const reportHash = sha256Hex(JSON.stringify(report));
  return {
    ...input,
    evidence: {
      ...input.evidence,
      after: [
        ...(Array.isArray(input.evidence.after) ? input.evidence.after : []),
        {
          ref: {
            revision: 1,
            hash: candidateHash,
            path: `brief-recovery/planner-candidate-${candidateHash}.json`,
          },
          payload: candidate,
        },
        {
          ref: {
            revision: 1,
            hash: reportHash,
            path: `brief-recovery/planner-report-${reportHash}.json`,
          },
          payload: report,
        },
      ],
    },
  };
}
