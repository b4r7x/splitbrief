import type { Attachment } from '../../core/schemas/attachment.js';
import { TASKS_FILE } from '../../core/paths.js';
import type {
  PlannerCallbacks,
  PlanOptions,
  PlanResult,
  PriorMessage,
  PlannerInvokeResult,
} from './types.js';
import { normalizePlannerPhase } from './normalize.js';
import { formatMessagesForCli } from '../streaming/format-messages.js';
import { createTranscriptBuffer } from '../streaming/transcript-buffer.js';
import {
  buildProjectLanguageContext,
  type LanguageContext,
} from '../spec/prompts/language-context.js';
import { parseTasksStrict } from '../spec/tasks/parse.js';
import { buildProjectContextMarkdown } from './context.js';
import { toTokenDelta } from '../calls/projection.js';
import type { RunnerCallContext } from '../calls/types.js';
import { requireCompletedCall } from './require-completed-call.js';
import { createTaskCompilationAttemptId } from '../../core/schemas/task-compilation.js';

type SinglePhaseConfig = {
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
};

type InvokeExtras = {
  priorMessages?: PriorMessage[];
  images?: Attachment[];
};

const DEFAULT_BACKEND_KIND: RunnerCallContext['backendKind'] = 'cli';

let singlePhaseCallSequence = 0;

function createSinglePhaseCallContext(config: SinglePhaseConfig): RunnerCallContext {
  return {
    callId: `single-phase-${++singlePhaseCallSequence}`,
    attemptId: createTaskCompilationAttemptId(),
    role: 'planner',
    backendKind: config.backendKind ?? DEFAULT_BACKEND_KIND,
    transport: { kind: 'stdout-final' },
    ...(config.runnerName !== undefined && { runnerName: config.runnerName }),
    ...(config.model !== undefined && { model: config.model }),
  };
}

export function formatRepoMapBlock(codebaseContext: string | undefined): string {
  return codebaseContext ? `<repo-map>\n${codebaseContext}\n</repo-map>\n\n` : '';
}

export function prepareInvokeArgs(opts: {
  prompt: string;
  priorMessages: PriorMessage[] | undefined;
  images: Attachment[] | undefined;
  consumesPriorMessages: boolean | undefined;
}): { effectivePrompt: string; extras: InvokeExtras } {
  const { prompt, priorMessages, images, consumesPriorMessages } = opts;
  const hasPrior = priorMessages !== undefined && priorMessages.length > 0;
  const effectivePrompt =
    hasPrior && !consumesPriorMessages ? formatMessagesForCli(priorMessages) + prompt : prompt;
  const hasImages = images !== undefined && images.length > 0;
  const extras: InvokeExtras = {
    ...(consumesPriorMessages && hasPrior ? { priorMessages } : {}),
    ...(hasImages ? { images } : {}),
  };
  return { effectivePrompt, extras };
}

export async function runSinglePhasePlanning(
  config: SinglePhaseConfig,
  promptBuilder: (
    feature: string,
    projectContext: string,
    languageContext: LanguageContext,
  ) => string,
  opts: PlanOptions,
): Promise<PlanResult> {
  const { feature, projectDir, callbacks, codebaseContext } = opts;
  const projectContext = await buildProjectContextMarkdown(projectDir);
  const languageContext = buildProjectLanguageContext(
    projectDir,
    callbacks.discoveredValidation?.language,
  );
  const repoMapBlock = formatRepoMapBlock(codebaseContext);
  const prompt = repoMapBlock + promptBuilder(feature, projectContext, languageContext);

  callbacks.onPhase?.('planning');
  const buffer = createTranscriptBuffer({
    projectDir,
    sessionId: callbacks.sessionId ?? '',
    phase: 'planning',
  });
  const { effectivePrompt, extras } = prepareInvokeArgs({
    prompt,
    priorMessages: callbacks.priorMessages,
    images: callbacks.attachments,
    consumesPriorMessages: config.consumesPriorMessages,
  });
  const callContext = createSinglePhaseCallContext(config);
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
        artifactFile: TASKS_FILE,
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

  const tasksContent = result.text;
  const tasks = parseTasksStrict(tasksContent, callbacks.onWarning);
  return {
    spec: '',
    plan: '',
    tasks,
    usage: toTokenDelta(result.usage),
    phases: [
      normalizePlannerPhase({
        result,
        callContext,
        logicalName: TASKS_FILE,
        text: tasksContent,
      }),
    ],
  };
}
