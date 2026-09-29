import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  opensPlanGate,
  plannerStepsFor,
  type PlannerStep,
} from '../../../core/pipeline-spec/steps.js';
import { isPlannerDocument } from '../../../core/pipeline-spec/planner-documents.js';
import { extractQuestionsFromStream } from '../../parsers/question.js';
import {
  PLAN_FILE,
  RESEARCH_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../../core/paths.js';
import { readSpecFileOrEmpty } from '../../../core/paths-io.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { GateName, PlannerCall } from '../../../core/schemas/run-step.js';
import type { MachineAction } from '../../../core/state/types.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { artifactPresence } from '../../../core/sessions/run-record-io.js';
import { resumeStep } from '../../../core/sessions/run-status.js';
import { nowIso } from '../../../utils/format-time.js';
import { buildProjectContextMarkdown } from '../../planners/context.js';
import { isPlannerDocumentCall } from '../../planners/types.js';
import type { PhaseInputs } from '../../planners/types.js';
import {
  buildProjectLanguageContext,
  extractLanguageFromResearch,
} from '../../spec/prompts/language-context.js';
import { formatTasks } from '../../spec/formatter.js';
import { writeAndPublishArtifacts } from '../artifact-write.js';
import { runApprovalLoop } from '../approval/loop.js';
import { publishPlannerStatus, publishWarning } from '../events.js';
import { buildPlannerNoBriefsRecoveryIssue } from '../recovery/builders/planner.js';
import { addUsageAndSave, raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import { runPlannerCallInContinuationLoop } from './call-loop.js';
import { handlePlanningFailure } from './failure.js';
import { invalidateFrom } from './invalidate.js';
import { persistPhases, readPersistedTasks } from './io.js';
import { drainAndFormat } from './queue-drain.js';
import { parseDiscoveredValidation } from './parse-validation.js';
import { sanitizeDiscoveredValidation } from './sanitize-discovered-validation.js';
import { buildPlanningSkillsContext } from './skills-context.js';
import { runAnalyzeCall, runClarifyCall, runConstitutionCall } from './speckit.js';
import type { PlanningProducerResult, PlanningStepsOptions } from './types.js';

const GATE_FILE: Record<'spec' | 'plan', typeof SPEC_FILE | typeof PLAN_FILE> = {
  spec: SPEC_FILE,
  plan: PLAN_FILE,
};

const PHASE_HINT: Record<PlannerCall, string> = {
  research: 'analyzing codebase',
  spec: 'writing the spec',
  clarify: 'collecting clarifications',
  constitution: 'checking the constitution',
  plan: 'writing the plan',
  tasks: 'compiling Task Briefs',
  analyze: 'cross-checking spec, plan and briefs',
};

/** The action that moves the machine into the phase a step runs in. */
function enteringAction(from: Phase, to: Phase): MachineAction | null {
  if (from === to) return null;
  switch (to) {
    case 'researching':
      return { type: 'START' };
    case 'specifying':
      return { type: 'RESEARCH_DONE' };
    case 'clarifying':
      return { type: 'SPEC_CLARIFY_START' };
    case 'constitution-check':
      return { type: 'SPEC_CLARIFY_DONE' };
    case 'planning':
      if (from === 'reviewing-spec') return { type: 'APPROVE_SPEC' };
      if (from === 'constitution-check') return { type: 'CONSTITUTION_CHECK_PASS' };
      return { type: 'BEGIN_PLANNING' };
    case 'analyzing':
      return { type: 'ANALYZE_START' };
    default:
      return null;
  }
}

function hasArtifact(ref: { projectDir: string; sessionId: string }, step: PlannerStep): boolean {
  if (step.artifact === null) return false;
  if (step.call === 'research')
    return isPlannerDocument('research', readSpecFileOrEmpty(ref, RESEARCH_FILE));
  return existsSync(join(sessionDir(ref.projectDir, ref.sessionId), step.artifact));
}

function stepIndexFor(
  steps: readonly PlannerStep[],
  startAt: PlannerCall | undefined,
  state: WorkflowState,
  ref: { projectDir: string; sessionId: string },
): number {
  const at = (index: number): number => (index < 0 ? 0 : index);
  if (state.pendingPlannerConversation !== undefined) {
    return at(steps.findIndex((step) => step.call === state.pendingPlannerConversation?.call));
  }
  if (startAt !== undefined) return at(steps.findIndex((step) => step.call === startAt));
  const resume = resumeStep(state, artifactPresence(ref));
  if (resume.kind === 'planner') return at(steps.findIndex((step) => step.call === resume.call));
  if (resume.kind === 'gate') return at(steps.findIndex((step) => step.gateAfter === resume.gate));
  return 0;
}

/**
 * Runs a mode's planner steps in order. Every step is memoized by its artifact,
 * so a run that stopped anywhere picks up at the first artifact it has not
 * written yet; every call transitions the phase before it starts and persists its
 * artifact before the next one begins, so `state.json` always names the call that
 * is running.
 */
export async function runPlanningSteps(
  opts: PlanningStepsOptions,
): Promise<PlanningProducerResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, bus, callbacks, metadata, resumeHolder } = wctx;
  const ref = { projectDir, sessionId };
  let state = opts.state;
  const mode = state.mode ?? 'standard';
  const approveLevel = opts.approveLevel ?? state.approve ?? 'default';
  const steps = plannerStepsFor(mode, approveLevel);
  // Compiled briefs wait at the plan gate only in a run whose steps open it; the others keep them
  // in planning, the phase that compiled them.
  const planGate = opensPlanGate(mode, approveLevel);
  const briefsCompiled = (compiled: Task[]): MachineAction =>
    planGate
      ? { type: 'PLAN_DONE', tasks: compiled }
      : { type: 'BRIEFS_COMPILED', tasks: compiled };
  const skillsContext = await buildPlanningSkillsContext(opts, state);
  const passedGates = new Set<GateName>(opts.passedGates ?? []);
  let languageContext = buildProjectLanguageContext(
    projectDir,
    extractLanguageFromResearch(readSpecFileOrEmpty(ref, RESEARCH_FILE)) ??
      state.discoveredValidation?.language,
  );
  let priorMessages = resumeHolder?.messages;
  let attachments = opts.attachments;
  let tasks: Task[] = [...state.tasks];

  const readTasks = async (): Promise<Task[]> => {
    if (tasks.length > 0) return tasks;
    const persisted = await readPersistedTasks(join(sessionDir(projectDir, sessionId), TASKS_FILE));
    return persisted.ok ? persisted.tasks : tasks;
  };

  const legacyResearch = readSpecFileOrEmpty(ref, RESEARCH_FILE);
  if (
    mode !== 'quick' &&
    state.pendingPlannerConversation === undefined &&
    legacyResearch.trim() !== '' &&
    !isPlannerDocument('research', legacyResearch) &&
    !existsSync(join(sessionDir(projectDir, sessionId), SPEC_FILE))
  ) {
    const previousStep =
      opts.startAt === undefined
        ? resumeStep(state, artifactPresence(ref))
        : { kind: 'planner' as const, call: opts.startAt };
    const continuation = wctx.continuation?.take(previousStep);
    wctx.continuation?.hold({ kind: 'planner', call: 'research' }, continuation?.steer);
    state = transitionAndSave(ref, state, {
      type: 'SET_PLANNER_CONVERSATION',
      conversation: {
        call: 'research',
        text: legacyResearch,
        questions: extractQuestionsFromStream(legacyResearch).slice(0, 5),
        answers: [],
        answered: false,
      },
    });
  }
  const start = stepIndexFor(steps, opts.startAt, state, ref);
  let index = start;

  try {
    // Assembling what the plan seat is given is part of the call, not a preamble
    // to it: a context this step cannot be handed halts the step it was for,
    // under the recovery every other planning failure already goes through.
    const projectContext = await buildProjectContextMarkdown(projectDir);
    while (index < steps.length) {
      const step = steps[index];
      if (step === undefined) break;

      if (
        hasArtifact(ref, step) &&
        state.pendingPlannerConversation?.call === step.call &&
        state.pendingPlannerConversation.answered
      ) {
        state = transitionAndSave(ref, state, { type: 'CLEAR_PLANNER_CONVERSATION' });
      }

      if (!hasArtifact(ref, step)) {
        if (opts.beforeFirstCall && !(await opts.beforeFirstCall())) {
          return { disposition: 'terminal', state, outcome: 'cancelled' };
        }
        const entering = enteringAction(state.phase, step.phase);
        if (entering !== null) state = transitionAndSave(ref, state, entering);
        publishPlannerStatus(bus, state, 'running', { call: step.call });

        if (isPlannerDocumentCall(step.call)) {
          // Messages queued while the last call ran lead this call's prompt.
          const drained = drainAndFormat(projectDir, sessionId, state, bus);
          state = drained.state;
          if (
            drained.prefix !== '' &&
            state.pendingPlannerConversation !== undefined &&
            !state.pendingPlannerConversation.answered
          ) {
            const pending = state.pendingPlannerConversation;
            state = transitionAndSave(ref, state, {
              type: 'SET_PLANNER_CONVERSATION',
              conversation: {
                ...pending,
                answers: [
                  ...pending.answers,
                  {
                    reply: pending.text,
                    answer: drained.messages.map((message) => message.text).join('\n\n'),
                  },
                ],
                answered: true,
              },
            });
          }
          const inputs: PhaseInputs = {
            feature: opts.feature,
            projectContext,
            languageContext,
            ...(step.inputs.includes('research') && {
              research: readSpecFileOrEmpty(ref, RESEARCH_FILE),
            }),
            ...(step.inputs.includes('spec') && { spec: readSpecFileOrEmpty(ref, SPEC_FILE) }),
            ...(step.inputs.includes('plan') && { plan: readSpecFileOrEmpty(ref, PLAN_FILE) }),
            ...(skillsContext !== undefined && { skillsContext }),
            ...(opts.codebaseContext !== undefined && { codebaseContext: opts.codebaseContext }),
            ...(drained.prefix !== '' && { promptPrefix: drained.prefix }),
            ...(priorMessages && priorMessages.length > 0 ? { priorMessages } : {}),
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
            ...(mode === 'quick' && step.call === 'tasks'
              ? { quickPlan: { trivial: opts.trivial === true } }
              : {}),
          };
          const run = await runPlannerCallInContinuationLoop({
            wctx,
            state,
            planner,
            call: step.call,
            inputs,
            phaseHint: PHASE_HINT[step.call],
          });
          if (run.result.kind === 'conversation') {
            return { disposition: 'terminal', state: run.state, outcome: 'input-required' };
          }
          state = addUsageAndSave(wctx, run.state, 'planner', run.result.usage);
          priorMessages = undefined;
          attachments = undefined;
          if (step.call === 'research') {
            state = recordDiscoveredValidation(opts, state, run.result.text);
            languageContext = buildProjectLanguageContext(
              projectDir,
              extractLanguageFromResearch(run.result.text) ?? state.discoveredValidation?.language,
            );
          }
          if (step.call === 'tasks') {
            tasks = run.result.tasks ?? [];
            // A call that parsed no brief writes no artifact: the step stays
            // un-memoized so re-issuing it is what the operator's answer does.
            if (tasks.length > 0) {
              writeAndPublishArtifacts({
                projectDir,
                sessionId,
                bus,
                phase: state.phase,
                metadata,
                items: [{ kind: 'task-briefs', text: formatTasks(tasks) }],
              });
            }
          } else {
            persistPhases({
              projectDir,
              sessionId,
              phases: [run.result.artifact],
              metadata,
              bus,
              phase: state.phase,
            });
          }
          if (state.pendingPlannerConversation !== undefined) {
            state = transitionAndSave(ref, state, { type: 'CLEAR_PLANNER_CONVERSATION' });
          }
        } else {
          const special = await runSpeckitCall(step.call, {
            opts,
            state,
            feature: opts.feature,
            tasks: await readTasks(),
          });
          state = special.state;
          if (special.halted) {
            return { disposition: 'terminal', state, outcome: 'halted' };
          }
        }

        // A call that actually ran makes every artifact below it stale, so the
        // steps that wrote them run again against the document just produced.
        invalidateFrom(ref, step.call);
        if (step.call !== 'tasks') tasks = [];
      }

      if (step.call === 'tasks') {
        tasks = await readTasks();
        if (tasks.length === 0) return noBriefsHalt(opts, state);
        state = transitionAndSave(ref, state, briefsCompiled(tasks));
        if (planGate) publishPlannerStatus(bus, state, 'running');
      }

      if (
        step.gateAfter !== null &&
        step.gateAfter !== 'briefs' &&
        !passedGates.has(step.gateAfter)
      ) {
        const gate = step.gateAfter;
        state = enterGatePhase(opts, state, gate, await readTasks());
        const loop = await runApprovalLoop({
          type: gate,
          filePath: join(sessionDir(projectDir, sessionId), GATE_FILE[gate]),
          planner,
          projectDir,
          sessionId,
          callbacks,
          bus,
          state,
          signal: wctx.signal,
          specMetadata: metadata,
          sinks: wctx.sinks,
        });
        state = loop.state;
        if (loop.closed) return { disposition: 'terminal', state, outcome: 'closed' };
        if (loop.aborted) return { disposition: 'terminal', state, outcome: 'cancelled' };
        passedGates.add(gate);
        if (loop.regenerated) {
          invalidateFrom(ref, gate);
          tasks = [];
          index = start;
          continue;
        }
      }

      index++;
    }

    tasks = await readTasks();
    if (tasks.length === 0) return noBriefsHalt(opts, state);
    if (state.phase !== (planGate ? 'reviewing-plan' : 'planning')) {
      state = transitionAndSave(ref, state, briefsCompiled(tasks));
      if (planGate) publishPlannerStatus(bus, state, 'running');
    }
  } catch (err) {
    return handlePlanningFailure({ err, projectDir, sessionId, state, wctx });
  }

  return { disposition: 'tasks-ready', state: { ...state, tasks }, tasks };
}

function recordDiscoveredValidation(
  opts: PlanningStepsOptions,
  state: WorkflowState,
  researchText: string,
): WorkflowState {
  const discovered = sanitizeDiscoveredValidation(parseDiscoveredValidation(researchText), {
    bus: opts.wctx.bus,
    phase: state.phase,
  });
  return discovered ? { ...state, discoveredValidation: discovered } : state;
}

function noBriefsHalt(
  opts: PlanningStepsOptions,
  state: WorkflowState,
): Extract<PlanningProducerResult, { disposition: 'terminal' }> {
  const { projectDir, sessionId, bus } = opts.wctx;
  publishWarning({
    bus,
    phase: state.phase,
    message:
      'the planner produced text but no parsable Task Brief; the failed attempt contributes no Brief generation',
    safety: { category: 'planner', code: 'planner_returned_zero_tasks' },
  });
  const issue = buildPlannerNoBriefsRecoveryIssue({
    phase: state.phase,
    message: 'The planner produced text but no parsable Task Brief.',
    details: ['Re-issue the call, or send the planner a correction and let it try again.'],
    createdAt: nowIso(),
  });
  return {
    disposition: 'terminal',
    state: raisePendingRecovery({ projectDir, sessionId, bus }, state, issue),
    outcome: 'halted',
  };
}

/** A gate is a durable wait: the phase it parks at is on disk before it opens. */
function enterGatePhase(
  opts: PlanningStepsOptions,
  state: WorkflowState,
  gate: 'spec' | 'plan',
  tasks: Task[],
): WorkflowState {
  const { projectDir, sessionId, bus } = opts.wctx;
  const ref = { projectDir, sessionId };
  const target: Phase = gate === 'spec' ? 'reviewing-spec' : 'reviewing-plan';
  if (state.phase === target) return state;
  const next = transitionAndSave(
    ref,
    state,
    gate === 'spec' ? { type: 'SPEC_DONE' } : { type: 'PLAN_DONE', tasks },
  );
  publishPlannerStatus(bus, next, 'running');
  return next;
}

async function runSpeckitCall(
  call: PlannerCall,
  ctx: {
    opts: PlanningStepsOptions;
    state: WorkflowState;
    feature: string;
    tasks: Task[];
  },
): Promise<{ state: WorkflowState; halted: boolean }> {
  switch (call) {
    case 'clarify':
      return { state: runClarifyCall(ctx.opts, ctx.state), halted: false };
    case 'constitution':
      return runConstitutionCall(ctx.opts, ctx.state, ctx.feature);
    case 'analyze':
      return { state: await runAnalyzeCall(ctx.opts, ctx.state), halted: false };
    default:
      return { state: ctx.state, halted: false };
  }
}
