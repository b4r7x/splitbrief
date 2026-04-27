import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { OrchestratorCallbacks, PlannerCallbacksContext } from '../types.js';
import type { EventBus } from '../../events/types.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { createBusTextHandler, publishError } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { createSessionExpiredHandler } from '../resume-context.js';
import { withContinuationLoop } from '../continuation.js';
import { labelError } from '../../../utils/format-errors.js';
import type { Planner, PlanResult, PlannerCallbacks, PriorMessage } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import type { SkillMeta } from '../../skills/discovery.js';
import type { ApproveLevel, Phase } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import { BRIEF_QUALITY_FILE, TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { evaluateBriefQuality } from '../../spec/brief-quality.js';
import { formatTasks } from '../../spec/formatter.js';
import { parseTasks } from '../../spec/parser.js';
import type { BriefQualityReport } from '../../spec/brief-quality.js';
import { drainQueue, formatDrainedMessages } from '../queue.js';
import { regenerateFromFeedback } from '../continuation.js';
import { buildRejectionContext, readEvidenceLedger } from '../evidence.js';

export const MAX_CLARIFICATION_QUESTIONS = 5;

export type PlanningPhaseOptions = {
  wctx: PlannerCallbacksContext;
  planner: Planner;
  state: WorkflowState;
  feature: string;
  selectedSkills?: SkillMeta[] | undefined;
  rewindPending?: { target: 'spec' | 'plan'; comment?: string | undefined } | undefined;
  codebaseContext?: string | undefined;
  approveLevel?: ApproveLevel | undefined;
  attachments?: Attachment[] | undefined;
  deferBriefGate?: boolean | undefined;
};

export type PlanningPhaseResult = { state: WorkflowState; tasks: Task[]; cancelled: boolean };

export function drainAndFormat(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  bus: EventBus,
): { state: WorkflowState; prefix: string } {
  const drain = drainQueue(projectDir, sessionId, state, bus);
  if (drain.messages.length === 0) return { state, prefix: '' };
  return { state: drain.state, prefix: formatDrainedMessages(drain.messages) };
}

export function persistPhases(projectDir: string, sessionId: string, phases: PlanResult['phases'], metadata: SpecMetadata): void {
  for (const phase of phases ?? []) {
    writeSpecFile(projectDir, sessionId, phase.filename, phase.text, metadata);
  }
}

export function handlePlanningFailure(
  err: unknown, projectDir: string, sessionId: string, state: WorkflowState, wctx: PlannerCallbacksContext,
): { state: WorkflowState; tasks: Task[]; cancelled: true } {
  publishError(wctx.bus, state.phase, labelError('Planning failed', err));
  return { state: transitionAndSave(projectDir, sessionId, state, { type: 'CANCEL' }), tasks: [], cancelled: true };
}

export function runBriefQualityGate(
  tasks: Task[],
  projectDir: string,
  sessionId: string,
  bus: EventBus,
  phase: Phase,
): { report: BriefQualityReport; ok: boolean } {
  const report = evaluateBriefQuality(tasks);
  writeSpecFile(projectDir, sessionId, BRIEF_QUALITY_FILE, JSON.stringify(report, null, 2), null);
  const errorCount = report.issues.filter(i => i.severity === 'error').length;
  const warningCount = report.issues.filter(i => i.severity === 'warning').length;
  if (report.passed) {
    bus.publish({ type: 'brief_quality_passed', ts: Date.now(), phase, score: report.score, warningCount });
  } else {
    bus.publish({ type: 'brief_quality_failed', ts: Date.now(), phase, score: report.score, errorCount, warningCount });
  }
  return { report, ok: report.passed };
}

export async function regenerateTasks(
  projectDir: string,
  sessionId: string,
  planner: Planner,
  callbacks: OrchestratorCallbacks,
  bus: EventBus,
  state: WorkflowState,
  metadata: SpecMetadata,
  planOverride?: string,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  const result = await regenerateFromFeedback('tasks', {
    projectDir, sessionId, planner, callbacks, bus, state, metadata, planOverride,
  });
  return { state: result.state, tasks: result.tasks };
}

export async function regeneratePlanAndTasks(
  projectDir: string,
  sessionId: string,
  planner: Planner,
  callbacks: OrchestratorCallbacks,
  bus: EventBus,
  state: WorkflowState,
  metadata: SpecMetadata,
  skillsContext?: string,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  const planRegen = await regenerateFromFeedback('plan', {
    projectDir, sessionId, planner, callbacks, bus, state, metadata, skillsContext,
  });
  const taskRegen = await regenerateFromFeedback('tasks', {
    projectDir, sessionId, planner, callbacks, bus, state: planRegen.state, metadata, planOverride: planRegen.plan,
  });
  return { state: taskRegen.state, tasks: taskRegen.tasks };
}

export async function regenerateTasksIfNeeded(
  regenerated: boolean,
  projectDir: string,
  sessionId: string,
  planner: Planner,
  callbacks: OrchestratorCallbacks,
  bus: EventBus,
  state: WorkflowState,
  tasks: Task[],
  metadata: SpecMetadata,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  if (!regenerated) return { state, tasks };
  return regenerateTasks(projectDir, sessionId, planner, callbacks, bus, state, metadata);
}

export type PlannerCallRunResult = {
  state: WorkflowState;
  result: PlanResult;
};

export type PlannerCallOptions = {
  wctx: PlannerCallbacksContext;
  state: WorkflowState;
  planner: Planner;
  feature: string;
  mode: 'quick' | 'speckit';
  skillsContext?: string | undefined;
  codebaseContext?: string | undefined;
  priorMessages?: PriorMessage[] | undefined;
  collectedQuestions?: ClarificationQuestion[] | undefined;
  attachments?: Attachment[] | undefined;
};

export async function runPlannerCallInContinuationLoop(
  opts: PlannerCallOptions,
): Promise<PlannerCallRunResult> {
  const { wctx, planner, feature, mode, skillsContext, codebaseContext, priorMessages, collectedQuestions, attachments } = opts;
  const { projectDir, sessionId, config, callbacks, resumeHolder, sinks, signal } = wctx;
  let state = opts.state;
  const textHandler = createBusTextHandler(wctx.bus, state.phase);
  const conversational = planner.capabilities.supportsConversationalPlanning;
  let attachmentsConsumed = false;

  const loop = await withContinuationLoop<PlanResult>({
    ctx: { projectDir, sessionId, callbacks, signal, sinks },
    state,
    onStateChange: (s) => { state = s; },
    body: async ({ continuationPrompt, recordOutput }) => {
      let prompt = continuationPrompt ?? feature;

      // Inject prior approval rejection context so the planner can adapt and avoid
      // re-proposing actions the user has already declined.
      if (config.approval?.feedRejectionsToPlanner !== false) {
        try {
          const ledger = readEvidenceLedger(projectDir, sessionId);
          if (ledger) {
            const rejectionCtx = buildRejectionContext(ledger);
            if (rejectionCtx.length > 0) {
              prompt = `${rejectionCtx}\n${prompt}`;
            }
          }
        } catch {
          // Best-effort: never fail the planner call because the ledger is unreadable.
        }
      }

      const callAttachments = !attachmentsConsumed && attachments && attachments.length > 0 ? attachments : undefined;
      attachmentsConsumed = true;
      const plannerCallbacks: PlannerCallbacks = {
        onOutput: (text) => { recordOutput(text); textHandler(text); },
        onSessionId: (id) => { state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PLANNER_SESSION_ID', sessionId: id }); },
        onSessionExpired: createSessionExpiredHandler({ projectDir, sessionId, callbacks, bus: wctx.bus, config, resumeHolder }),
        sessionId,
        persistTranscript: config.workflow.persistTranscript,
        ...(priorMessages && priorMessages.length > 0 ? { priorMessages } : {}),
        ...(callAttachments ? { attachments: callAttachments } : {}),
        ...(mode === 'speckit' && conversational && collectedQuestions
          ? {
              onQuestion: (questions) => {
                for (const q of questions) {
                  if (collectedQuestions.length < MAX_CLARIFICATION_QUESTIONS) {
                    collectedQuestions.push(q);
                  }
                }
              },
            }
          : {}),
      };

      if (mode === 'quick') {
        const quickPlanFn = planner.quickPlan ?? planner.plan;
        const result = await quickPlanFn.call(planner, prompt, projectDir, plannerCallbacks, codebaseContext);
        return { value: result };
      }
      const result = await planner.plan(prompt, projectDir, plannerCallbacks, skillsContext, codebaseContext);
      return { value: result };
    },
  });

  state = loop.state;
  return { state, result: loop.value };
}

export type BriefsApprovalLoopOptions = {
  tasks: Task[];
  planner: Planner;
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  state: WorkflowState;
  metadata: SpecMetadata;
  signal?: AbortSignal | undefined;
};

export type BriefsApprovalLoopResult = {
  state: WorkflowState;
  tasks: Task[];
  rejected: boolean;
};

type PersistedTasksResult =
  | { ok: true; tasks: Task[] }
  | { ok: false; reason: 'missing' | 'unreadable' | 'parse' | 'empty'; message: string };

async function readPersistedTasks(tasksFilePath: string): Promise<PersistedTasksResult> {
  let text: string;
  try {
    text = await readFile(tasksFilePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, reason: 'missing', message: `Task Brief file is missing: ${tasksFilePath}` };
    }
    return { ok: false, reason: 'unreadable', message: labelError('Failed to read Task Brief file', err) };
  }

  if (text.trim() === '') {
    return { ok: false, reason: 'empty', message: `Task Brief file is empty: ${tasksFilePath}` };
  }

  try {
    const parsed = parseTasks(text);
    if (parsed.length === 0) {
      return { ok: false, reason: 'empty', message: `Task Brief file has no parseable tasks: ${tasksFilePath}` };
    }
    return { ok: true, tasks: parsed };
  } catch (err) {
    return { ok: false, reason: 'parse', message: labelError('Failed to parse Task Brief file', err) };
  }
}

async function readTasksForApproval(
  tasksFilePath: string,
  currentTasks: Task[],
  projectDir: string,
  sessionId: string,
  metadata: SpecMetadata,
): Promise<PersistedTasksResult> {
  const first = await readPersistedTasks(tasksFilePath);
  if (first.ok || first.reason !== 'missing') return first;
  if (currentTasks.length === 0) return first;
  writeSpecFile(projectDir, sessionId, TASKS_FILE, formatTasks(currentTasks), metadata);
  return readPersistedTasks(tasksFilePath);
}

function publishBriefQualityFailure(bus: EventBus, phase: Phase, report: BriefQualityReport): void {
  const firstError = report.issues.find(i => i.severity === 'error');
  publishError(bus, phase, `Task Brief quality gate failed: ${firstError?.message ?? 'unknown error'}`);
}

export async function runBriefsApprovalLoop(opts: BriefsApprovalLoopOptions): Promise<BriefsApprovalLoopResult> {
  const { planner, projectDir, sessionId, callbacks, bus, metadata, signal } = opts;
  let { state, tasks } = opts;

  const tasksFilePath = join(sessionDir(projectDir, sessionId), TASKS_FILE);

  try {
    await readFile(tasksFilePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && tasks.length > 0) {
      writeSpecFile(projectDir, sessionId, TASKS_FILE, formatTasks(tasks), metadata);
    }
  }

  state = transitionAndSave(projectDir, sessionId, state, { type: 'BRIEFS_READY', tasks });

  while (true) {
    if (signal?.aborted) return { state, tasks, rejected: false };
    const result = await callbacks.onApprovalNeeded('briefs', tasksFilePath);
    if (signal?.aborted) return { state, tasks, rejected: false };

    if (result.action === 'edit') {
      const edited = await readPersistedTasks(tasksFilePath);
      if (!edited.ok) {
        publishError(bus, state.phase, edited.message);
        continue;
      }
      const { report, ok } = runBriefQualityGate(edited.tasks, projectDir, sessionId, bus, state.phase);
      if (!ok) {
        publishBriefQualityFailure(bus, state.phase, report);
        continue;
      }
      tasks = edited.tasks;
      state = transitionAndSave(projectDir, sessionId, state, { type: 'BRIEFS_READY', tasks });
      continue;
    }

    if (!result.approved && !result.comment) {
      state = transitionAndSave(projectDir, sessionId, state, { type: 'REJECT_BRIEFS' });
      return { state, tasks, rejected: true };
    }

    if (!result.comment) {
      const approved = await readTasksForApproval(tasksFilePath, tasks, projectDir, sessionId, metadata);
      if (!approved.ok) {
        publishError(bus, state.phase, approved.message);
        continue;
      }
      const { report, ok } = runBriefQualityGate(approved.tasks, projectDir, sessionId, bus, state.phase);
      if (!ok) {
        publishBriefQualityFailure(bus, state.phase, report);
        continue;
      }
      tasks = approved.tasks;
      state = transitionAndSave(projectDir, sessionId, state, { type: 'BRIEFS_READY', tasks });
      state = transitionAndSave(projectDir, sessionId, state, { type: 'APPROVE_BRIEFS' });
      return { state, tasks, rejected: false };
    }

    const message = {
      id: randomUUID(),
      text: result.comment,
      queuedAt: new Date().toISOString(),
      phase: state.phase as Phase,
      deliveredViaNative: false as const,
    };
    state = transitionAndSave(projectDir, sessionId, state, { type: 'ENQUEUE_USER_MSG', message });

    const regen = await regenerateTasks(projectDir, sessionId, planner, callbacks, bus, state, metadata);
    state = regen.state;
    tasks = regen.tasks;

    const { report, ok } = runBriefQualityGate(tasks, projectDir, sessionId, bus, state.phase);
    if (!ok) {
      const firstError = report.issues.find(i => i.severity === 'error');
      createBusTextHandler(bus, state.phase)(`\n[Brief quality gate failed after regeneration: ${firstError?.message ?? 'unknown error'}. Please review and try again.]\n`);
    }

    state = transitionAndSave(projectDir, sessionId, state, { type: 'BRIEFS_READY', tasks });
  }
}
