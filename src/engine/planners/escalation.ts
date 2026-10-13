import type { Task } from '../../core/schemas/task.js';
import type { InvokeResult } from '../runners/types.js';
import { captureChangeDetectorBaseline, createChangeDetector } from '../change-detection.js';
import { extractCode } from '../parsers/response-extractor.js';
import { buildEscalationPrompt } from '../spec/prompts/escalation.js';
import { buildProjectLanguageContext } from '../spec/prompts/language-context.js';
import type { EscalateOptions, EscalationResult, PlannerOutputCallbacks } from './types.js';
import { toInvokeResult, toTokenDelta } from '../calls/projection.js';
import type { RunnerCallContext, RunnerCallResult } from '../calls/types.js';
import { createRunnerCallId } from '../calls/call-id.js';
import { requireCompletedCall } from './require-completed-call.js';

type PlannerEscalationConfig = {
  invokeEscalate: (opts: {
    prompt: string;
    projectDir: string;
    callContext: RunnerCallContext;
    accessMode: 'read-only' | 'write-files';
    callbacks: PlannerOutputCallbacks;
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
  }) => Promise<RunnerCallResult>;
  backendKind?: RunnerCallContext['backendKind'];
  runnerName?: string | undefined;
  model?: string | undefined;
  axes?: readonly string[] | undefined;
  escalateFullMode?: 'text' | 'files';
  escalateFullPostProcess?: (
    task: Task,
    result: InvokeResult,
    extracted: { code: string },
    projectDir: string,
  ) => EscalationResult;
};

const DEFAULT_BACKEND_KIND: RunnerCallContext['backendKind'] = 'cli';

function createEscalationCallContext(config: PlannerEscalationConfig): RunnerCallContext {
  return {
    callId: createRunnerCallId('escalation'),
    role: 'escalation',
    backendKind: config.backendKind ?? DEFAULT_BACKEND_KIND,
    ...(config.runnerName !== undefined && { runnerName: config.runnerName }),
    ...(config.model !== undefined && { model: config.model }),
    ...(config.axes !== undefined && { axes: config.axes }),
  };
}

export async function escalateFull(
  config: PlannerEscalationConfig,
  opts: EscalateOptions,
): Promise<EscalationResult> {
  const { task, error, projectDir, callbacks, languageContext } = opts;
  const escalationPrompt = buildEscalationPrompt({
    task,
    lastAttempt: task.currentCode ?? '',
    error,
    languageContext: languageContext ?? buildProjectLanguageContext(projectDir, undefined),
    isolationDir: projectDir,
    outputMode: config.escalateFullMode === 'files' ? 'files' : 'text',
  });

  if (config.escalateFullMode === 'files') {
    const detect = createChangeDetector('Full escalation');
    const baseline = await captureChangeDetectorBaseline(projectDir, {
      kind: opts.changeDetection,
      ignoreProjectDir: opts.fileIgnoreProjectDir,
    });
    const callContext = createEscalationCallContext(config);
    const result = requireCompletedCall(
      await config.invokeEscalate({
        prompt: escalationPrompt,
        projectDir,
        callContext,
        accessMode: 'write-files',
        callbacks,
        signal: callbacks.signal,
        sandboxEnv: opts.sandboxEnv,
      }),
    );
    const { changed } = await detect(projectDir, baseline);
    return { success: changed, output: result.text, code: null, usage: toTokenDelta(result.usage) };
  }

  const callContext = createEscalationCallContext(config);
  const result = requireCompletedCall(
    await config.invokeEscalate({
      prompt: escalationPrompt,
      projectDir,
      callContext,
      accessMode: 'read-only',
      callbacks,
      signal: callbacks.signal,
      sandboxEnv: opts.sandboxEnv,
    }),
  );

  const extracted = extractCode(result.text);
  if ('error' in extracted) {
    return { success: false, output: result.text, code: null, usage: toTokenDelta(result.usage) };
  }

  if (config.escalateFullPostProcess) {
    return config.escalateFullPostProcess(task, toInvokeResult(result), extracted, projectDir);
  }

  return {
    success: true,
    output: result.text,
    code: extracted.code,
    usage: toTokenDelta(result.usage),
  };
}
