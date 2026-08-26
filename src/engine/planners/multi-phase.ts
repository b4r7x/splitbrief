import type { Attachment } from '../../core/schemas/attachment.js';
import type { Task } from '../../core/schemas/task.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { Phase } from '../../core/schemas/enums.js';
import type {
  PlanOptions,
  PlanResult,
  PlannerCallbacks,
  PhaseResult,
  PriorMessage,
  PlannerArtifactLogicalName,
  PlannerInvokeResult,
} from './types.js';
import { normalizePlannerPhase } from './normalize.js';
import { RESEARCH_FILE, SPEC_FILE, PLAN_FILE, TASKS_FILE } from '../../core/paths.js';
import { buildResearchPrompt } from '../spec/prompts/research.js';
import { buildSpecPrompt } from '../spec/prompts/spec.js';
import { buildPlanPrompt } from '../spec/prompts/plan.js';
import { buildTasksPrompt } from '../spec/prompts/tasks.js';
import {
  buildProjectLanguageContext,
  extractLanguageFromResearch,
  type LanguageContext,
} from '../spec/prompts/language-context.js';
import { parseTasksStrict } from '../spec/tasks/parse.js';
import { compileTaskBriefs } from '../spec/tasks/compiler.js';
import { buildProjectContextMarkdown } from './context.js';
import { accumulateTokenUsage } from '../calls/usage.js';
import { toTokenDelta } from '../calls/projection.js';
import { createTranscriptBuffer } from '../streaming/transcript-buffer.js';
import type { RunnerCallContext } from '../calls/types.js';
import type { TaskDispatchLedger } from '../calls/dispatch-ledger.js';
import type { PreparedPlannerInvocation } from '../runners/types.js';
import { requireCompletedCall } from './require-completed-call.js';
import { formatRepoMapBlock, prepareInvokeArgs } from './single-phase.js';
import { createPlannerCallContext } from './call-context.js';
import { admitPlanningArtifact } from '../spec/planning-artifact-admission.js';

type MultiPhaseConfig = {
  invokePlan: (opts: {
    prompt: string;
    projectDir: string;
    callContext: RunnerCallContext;
    callbacks: Pick<
      PlannerCallbacks,
      'onOutput' | 'onQuestion' | 'onSessionId' | 'onSessionExpired' | 'sessionId' | 'onCallEvent'
    >;
    priorMessages?: PriorMessage[] | undefined;
    images?: Attachment[] | undefined;
    artifactFile?: string | undefined;
    signal?: AbortSignal | undefined;
  }) => Promise<PlannerInvokeResult>;
  backendKind?: RunnerCallContext['backendKind'];
  runnerName?: string | undefined;
  model?: string | undefined;
  consumesPriorMessages?: boolean;
  /**
   * Deterministic Task compiler wiring. When present, standard/speckit Task
   * production runs through the compiler's detached fresh batches instead of
   * one legacy tasks prompt. The ledger is claimed immediately before every
   * batch invoke; detached batches never touch workflow session callbacks.
   */
  compiler?: Readonly<{
    invocation: PreparedPlannerInvocation;
    ledger: TaskDispatchLedger;
  }>;
};

const PHASE_MAP: Partial<Record<string, Phase>> = {
  researching: 'researching',
  specifying: 'specifying',
  planning: 'planning',
  'generating-tasks': 'planning',
};

type PlannerArtifactPhase = Phase | 'generating-tasks';

export async function runMultiPhasePlanning(
  config: MultiPhaseConfig,
  opts: PlanOptions,
): Promise<PlanResult> {
  const { feature, projectDir, callbacks, skillsContext, codebaseContext } = opts;
  const projectContext = await buildProjectContextMarkdown(projectDir);
  const repoMapBlock = formatRepoMapBlock(codebaseContext);
  let usage: TokenDelta | null = null;
  const phases: PhaseResult[] = [];

  let priorInjected = false;
  let imagesInjected = false;
  const pendingImages = callbacks.attachments;
  async function runPhase(
    phase: PlannerArtifactPhase,
    prompt: string,
    filename: PlannerArtifactLogicalName,
  ): Promise<string> {
    const plannerPhase = PHASE_MAP[phase];
    if (plannerPhase) callbacks.onPhase?.(plannerPhase);
    const buffer = createTranscriptBuffer({
      projectDir,
      sessionId: callbacks.sessionId ?? '',
      phase: plannerPhase,
      persistTranscript: callbacks.persistTranscript ?? true,
    });

    const priorMessages = !priorInjected ? callbacks.priorMessages : undefined;
    priorInjected = true;
    const images =
      !imagesInjected && pendingImages && pendingImages.length > 0 ? pendingImages : undefined;
    imagesInjected = true;

    const { effectivePrompt, extras } = prepareInvokeArgs({
      prompt,
      priorMessages,
      images,
      consumesPriorMessages: config.consumesPriorMessages,
    });

    const callContext = createPlannerCallContext(config, 'planner');
    let result: PlannerInvokeResult;
    try {
      result = requireCompletedCall(
        await config.invokePlan({
          prompt: effectivePrompt,
          projectDir,
          callContext,
          callbacks: {
            onOutput: (text) => {
              callbacks.onOutput(text);
              buffer.append(text);
            },
            onQuestion: callbacks.onQuestion,
            onSessionId: callbacks.onSessionId,
            onSessionExpired: callbacks.onSessionExpired,
            sessionId: callbacks.sessionId,
            onCallEvent: callbacks.onCallEvent,
          },
          ...extras,
          artifactFile: filename,
          signal: callbacks.signal,
        }),
      );
    } catch (err) {
      if (callbacks.signal?.aborted) {
        buffer.flushInterrupted();
      } else {
        buffer.flush();
      }
      throw err;
    }
    buffer.flush();
    const usageDelta = toTokenDelta(result.usage);
    if (usageDelta) usage = accumulateTokenUsage(usage, usageDelta);
    const artifactText = result.text;
    if (phase === 'specifying' || phase === 'planning') {
      admitPlanningArtifact({ phase, filename, text: artifactText });
    }
    phases.push(
      normalizePlannerPhase({
        result,
        callContext,
        logicalName: filename,
        text: artifactText,
      }),
    );
    return artifactText;
  }

  async function runTasksPhase(input: {
    spec: string;
    plan: string;
    languageContext: LanguageContext;
  }): Promise<{ tasks: Task[] }> {
    if (config.compiler === undefined) {
      const tasksMarkdown = await runPhase(
        'generating-tasks',
        buildTasksPrompt({
          spec: input.spec,
          plan: input.plan,
          languageContext: input.languageContext,
        }),
        TASKS_FILE,
      );
      return { tasks: parseTasksStrict(tasksMarkdown, callbacks.onWarning) };
    }
    callbacks.onPhase?.('planning');
    const compiler = config.compiler;
    let batchUsage: TokenDelta | null = null;
    const candidate = await compileTaskBriefs({
      inputs: {
        spec: input.spec,
        plan: input.plan,
        languageContext: input.languageContext.language,
      },
      invocation: compiler.invocation,
      ledger: compiler.ledger,
      dispatch: async ({ attemptId, batch, sessionScope, ledger }) => {
        const claim = ledger.claimDispatch(attemptId);
        if (claim.kind === 'refused') {
          return {
            callId: attemptId,
            attemptId,
            role: 'planner',
            backendKind: config.backendKind ?? 'cli',
            status: 'refused',
            terminalStatus: 'refused',
            failureCode: 'task_compiler_dispatch_limit',
            error: {
              code: 'task_compiler_dispatch_limit',
              message: `The task dispatch ceiling is refused (${claim.dispatchCount}/${claim.dispatchLimit}).`,
            },
            partial: false,
            startedAt: 0,
            endedAt: 0,
            durationMs: 0,
            text: '',
            usage: null,
            nativeSessionId: null,
            toolUses: [],
            artifacts: [],
            warnings: [],
          };
        }
        const result = await config.invokePlan({
          prompt: batch.prompt,
          projectDir,
          callContext: {
            ...createPlannerCallContext(
              {
                transport: compiler.invocation.transport,
                sessionScope,
                envelope: batch.envelope,
                ...(config.backendKind !== undefined && { backendKind: config.backendKind }),
                ...(config.runnerName !== undefined && { runnerName: config.runnerName }),
                ...(config.model !== undefined && { model: config.model }),
              },
              'planner',
            ),
            callId: attemptId,
            attemptId,
          },
          callbacks: { onOutput: () => {} },
          artifactFile: TASKS_FILE,
          signal: callbacks.signal,
        });
        const usageDelta = toTokenDelta(result.usage);
        if (usageDelta) batchUsage = accumulateTokenUsage(batchUsage, usageDelta);
        return result;
      },
    });
    if (batchUsage) usage = accumulateTokenUsage(usage, batchUsage);
    for (const artifact of candidate.artifacts) phases.push({ artifact });
    return { tasks: [...candidate.merge.tasks] };
  }

  const research = await runPhase(
    'researching',
    repoMapBlock + buildResearchPrompt(feature, projectContext, skillsContext),
    RESEARCH_FILE,
  );
  const languageContext = buildProjectLanguageContext(
    projectDir,
    extractLanguageFromResearch(research) ?? callbacks.discoveredValidation?.language,
  );
  const spec = await runPhase(
    'specifying',
    buildSpecPrompt(feature, research, languageContext),
    SPEC_FILE,
  );
  const plan = await runPhase(
    'planning',
    buildPlanPrompt({
      spec: { content: spec, hasClarifications: spec.includes('## Clarifications') },
      projectContext,
      skillsContext,
      languageContext,
    }),
    PLAN_FILE,
  );
  const { tasks } = await runTasksPhase({ spec, plan, languageContext });

  return { spec, plan, tasks, usage, phases };
}
