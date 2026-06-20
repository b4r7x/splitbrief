import type { Attachment } from '../../core/schemas/attachment.js';
import { TASKS_FILE } from '../../core/paths.js';
import type { PlannerCallbacks, PlanResult, PriorMessage } from './types.js';
import { formatMessagesForCli } from '../streaming/format-messages.js';
import { createTranscriptBuffer } from '../streaming/transcript-buffer.js';
import { error } from '../../utils/error.js';
import {
  buildProjectLanguageContext,
  type LanguageContext,
} from '../spec/prompts/language-context.js';
import { parseTasksStrict } from '../spec/parser.js';
import { buildProjectContextMarkdown } from './context.js';
import { toTokenDelta } from '../calls/projection.js';
import type { RunnerCallContext, RunnerCallResult } from '../calls/types.js';

type SinglePhaseConfig = {
  invokePlan: (opts: {
    prompt: string;
    projectDir: string;
    callContext: RunnerCallContext;
    callbacks: Pick<
      PlannerCallbacks,
      'onOutput' | 'onQuestion' | 'onSessionId' | 'onSessionExpired' | 'onCallEvent'
    >;
    priorMessages?: PriorMessage[] | undefined;
    images?: Attachment[] | undefined;
    signal?: AbortSignal | undefined;
  }) => Promise<RunnerCallResult>;
  backendKind?: RunnerCallContext['backendKind'];
  runnerName?: string | undefined;
  model?: string | undefined;
  readPhaseOutput?: (
    filename: string,
    resultText: string,
    projectDir: string,
    sessionId?: string,
  ) => string;
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
    role: 'planner',
    backendKind: config.backendKind ?? DEFAULT_BACKEND_KIND,
    ...(config.runnerName !== undefined && { runnerName: config.runnerName }),
    ...(config.model !== undefined && { model: config.model }),
  };
}

function requireCompletedCall(result: RunnerCallResult): RunnerCallResult {
  if (result.status === 'completed') return result;
  throw error('runner-call-failed', `Planner ${result.role} call ${result.status}`, {
    callId: result.callId,
    role: result.role,
    backendKind: result.backendKind,
    status: result.status,
    partial: result.partial,
    error: result.error,
  });
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
  feature: string,
  projectDir: string,
  callbacks: PlannerCallbacks,
  codebaseContext: string | undefined,
): Promise<PlanResult> {
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
    persistTranscript: callbacks.persistTranscript ?? true,
  });
  const { effectivePrompt, extras } = prepareInvokeArgs({
    prompt,
    priorMessages: callbacks.priorMessages,
    images: callbacks.attachments,
    consumesPriorMessages: config.consumesPriorMessages,
  });
  const callContext = createSinglePhaseCallContext(config);
  let result: RunnerCallResult;
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
          onCallEvent: callbacks.onCallEvent,
        },
        ...extras,
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

  const tasksContent = config.readPhaseOutput
    ? config.readPhaseOutput(TASKS_FILE, result.text, projectDir, callbacks.sessionId)
    : result.text;
  const tasks = parseTasksStrict(tasksContent, callbacks.onWarning);
  const rawOutput = tasksContent !== result.text ? result.text : undefined;
  return {
    spec: '',
    plan: '',
    tasks,
    usage: toTokenDelta(result.usage),
    phases: [{ text: tasksContent, filename: TASKS_FILE, rawOutput }],
  };
}
