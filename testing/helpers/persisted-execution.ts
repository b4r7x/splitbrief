import { BRIEF_QUALITY_FILE, TASKS_FILE } from '../../src/core/paths.js';
import { randomUUID } from 'node:crypto';
import { readSpecFile, writeSpecFile } from '../../src/core/paths-io.js';
import type { WorkflowState } from '../../src/core/schemas/workflow.js';
import type { BriefAdmissionInput } from '../../src/core/schemas/brief-recovery.js';
import { saveState } from '../../src/core/state/persistence.js';
import { createBriefRecoveryState } from '../../src/engine/orchestrator/planning/brief-recovery.js';
import { settleApprovedAdmission } from '../../src/engine/orchestrator/planning/brief-publication.js';
import { createEventBus } from '../../src/engine/events/bus.js';
import { evaluateBriefQuality } from '../../src/engine/spec/brief-quality.js';
import { formatTasks } from '../../src/engine/spec/formatter.js';
import { parseTasksStrict } from '../../src/engine/spec/tasks/parse.js';
import { readWorkflowStateHead } from '../../src/engine/orchestrator/state-ops.js';
import { sha256Hex } from '../../src/utils/sha256.js';

/**
 * Persist a task-run fixture through the same artifact and permit boundary as a
 * resumed workflow. The task bytes and quality report are reparsed before the
 * generation and permit are materialized, so tests cannot accidentally rely on
 * an in-memory-only ready state. The owner settlement seam
 * (`settleApprovedAdmission`) issues the execution permit through the sole
 * owner commit port and transitions BEGIN_IMPLEMENTATION from the post-commit
 * head, exactly as the approval loop settles an approved candidate.
 */
export function persistReadyExecutionState(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
): WorkflowState {
  const ref = { projectDir, sessionId };
  const preparing = {
    ...state,
    stateRevision: state.stateRevision ?? 0,
    stateFence: { token: 1, ownerId: 'phases-test-owner' },
    phase: 'reviewing-briefs' as const,
    authorityRevision: undefined,
    generation: null,
    permit: null,
    briefRecovery: null,
  } satisfies WorkflowState;
  saveState(ref, preparing);

  writeSpecFile(ref, TASKS_FILE, formatTasks(state.tasks), null);
  const tasksText = readSpecFile(ref, TASKS_FILE);
  if (tasksText === null) throw new Error('expected the canonical tasks.md fixture');
  const persistedTasks = parseTasksStrict(tasksText);
  const quality = evaluateBriefQuality(persistedTasks);
  const briefHash = sha256Hex(tasksText);
  const qualityText = JSON.stringify(
    {
      ...quality,
      briefHash,
      ruleVersion: 'brief-quality-v1',
    },
    null,
    2,
  );
  writeSpecFile(ref, BRIEF_QUALITY_FILE, qualityText, null);
  const persistedQualityText = readSpecFile(ref, BRIEF_QUALITY_FILE);
  if (persistedQualityText === null) {
    throw new Error('expected the canonical brief-quality.json fixture');
  }
  const qualityDigest = sha256Hex(persistedQualityText);
  const admission = {
    sessionId,
    origin: { mode: state.mode ?? 'standard', entry: 'initial' as const },
    continuation: {
      version: 1 as const,
      kind: 'approval' as const,
      mode: state.mode === 'speckit' ? ('speckit' as const) : ('standard' as const),
      entry: 'initial' as const,
    },
    activeBrief: { revision: preparing.stateRevision ?? 0, hash: briefHash, path: TASKS_FILE },
    report: {
      briefHash,
      report: { revision: 1 as const, hash: qualityDigest, path: BRIEF_QUALITY_FILE },
      ruleVersion: 'brief-quality-v1',
      issues: quality.issues,
      errorCount: quality.issues.filter((issue) => issue.severity === 'error').length,
    },
    qualityPolicyVersion: 'brief-quality-v1',
  } satisfies BriefAdmissionInput;
  const admitted = {
    ...preparing,
    briefRecovery: createBriefRecoveryState(admission, {
      // Per-call unique epoch: the same session may be persisted repeatedly
      // (resume fixtures), and a reused epoch name would collide the permit
      // evidence eventId in the session journal.
      epochId: `phases-test-epoch-${randomUUID()}`,
      evidenceHead: qualityDigest,
    }),
  } satisfies WorkflowState;
  saveState(ref, admitted);
  const settled = settleApprovedAdmission({
    ref,
    state: admitted,
    tasks: persistedTasks,
    bus: createEventBus(),
    writeState: () => {},
  });
  if (!settled.ok) {
    throw new Error(`expected the canonical ready execution settlement: ${settled.message}`);
  }
  const materialized = settled.state;
  const restored = {
    ...materialized,
    phase: state.phase,
    currentTaskIndex: state.currentTaskIndex,
    attempt: state.attempt,
    tasks: persistedTasks.map((task, index) => ({
      ...task,
      status: state.tasks[index]?.status ?? task.status,
      ...(state.tasks[index]?.currentCode === undefined
        ? {}
        : { currentCode: state.tasks[index].currentCode }),
    })),
  } satisfies WorkflowState;
  saveState(ref, restored);
  const head = readWorkflowStateHead(ref);
  if (head === null) throw new Error('expected the canonical owner state head');
  return head.state;
}
