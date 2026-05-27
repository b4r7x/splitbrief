import type { Attachment } from '../../core/schemas/attachment.js';
import { TASKS_FILE } from '../../core/paths.js';
import type { PlannerCallbacks, PlanResult, PriorMessage } from './types.js';
import { formatMessagesForCli } from '../streaming/format-messages.js';
import { createTranscriptBuffer } from '../streaming/transcript-buffer.js';
import { buildProjectLanguageContext, type LanguageContext } from '../spec/prompts/language-context.js';
import { parseTasks } from '../spec/parser.js';
import { buildProjectContextMarkdown } from './context.js';
import type { InvokeResult } from '../runners/types.js';

type SinglePhaseConfig = {
  invokePlan: (opts: {
    prompt: string;
    projectDir: string;
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onQuestion' | 'onSessionId' | 'onSessionExpired'>;
    priorMessages?: PriorMessage[] | undefined;
    images?: Attachment[] | undefined;
    signal?: AbortSignal | undefined;
  }) => Promise<InvokeResult>;
  readPhaseOutput?: (filename: string, resultText: string, projectDir: string, sessionId?: string) => string;
  consumesPriorMessages?: boolean;
};

type InvokeExtras = {
  priorMessages?: PriorMessage[];
  images?: Attachment[];
};

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
  const effectivePrompt = hasPrior && !consumesPriorMessages
    ? formatMessagesForCli(priorMessages) + prompt
    : prompt;
  const hasImages = images !== undefined && images.length > 0;
  const extras: InvokeExtras = {
    ...(consumesPriorMessages && hasPrior ? { priorMessages } : {}),
    ...(hasImages ? { images } : {}),
  };
  return { effectivePrompt, extras };
}

export async function runSinglePhasePlanning(
  config: SinglePhaseConfig,
  promptBuilder: (feature: string, projectContext: string, languageContext: LanguageContext) => string,
  _phaseName: string,
  feature: string,
  projectDir: string,
  callbacks: PlannerCallbacks,
  codebaseContext: string | undefined,
): Promise<PlanResult> {
  const projectContext = await buildProjectContextMarkdown(projectDir);
  const languageContext = buildProjectLanguageContext(projectDir, callbacks.discoveredValidation?.language);
  const repoMapBlock = formatRepoMapBlock(codebaseContext);
  const prompt = repoMapBlock + promptBuilder(feature, projectContext, languageContext);

  callbacks.onPhase?.('planning');
  const buffer = createTranscriptBuffer(
    projectDir, callbacks.sessionId ?? '', 'planning', callbacks.persistTranscript ?? true,
  );
  const { effectivePrompt, extras } = prepareInvokeArgs({
    prompt,
    priorMessages: callbacks.priorMessages,
    images: callbacks.attachments,
    consumesPriorMessages: config.consumesPriorMessages,
  });
  const result = await config.invokePlan({
    prompt: effectivePrompt,
    projectDir,
    callbacks: {
      onOutput: (text) => { callbacks.onOutput(text); buffer.append(text); },
      onQuestion: callbacks.onQuestion,
      onSessionId: callbacks.onSessionId,
      onSessionExpired: callbacks.onSessionExpired,
    },
    ...extras,
    signal: callbacks.signal,
  });
  buffer.flush();

  const tasksContent = config.readPhaseOutput
    ? config.readPhaseOutput(TASKS_FILE, result.text, projectDir, callbacks.sessionId)
    : result.text;
  const tasks = parseTasks(tasksContent);
  const rawOutput = tasksContent !== result.text ? result.text : undefined;
  return { spec: '', plan: '', tasks, usage: result.usage, phases: [{ text: tasksContent, filename: TASKS_FILE, rawOutput }] };
}
