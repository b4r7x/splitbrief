import type { Task } from '../../core/schemas/task.js';
import type { InvokeResult } from '../runners/types.js';
import { error } from '../../utils/error.js';
import { captureChangeDetectorBaseline, createChangeDetector } from '../change-detection.js';
import { extractCode } from '../parsers/response-extractor.js';
import { buildEscalationPrompt, buildHintPrompt } from '../spec/prompts/escalation.js';
import { buildProjectLanguageContext } from '../spec/prompts/language-context.js';
import type { EscalateOptions, EscalationResult, PlannerOutputCallbacks } from './types.js';
import { toInvokeResult, toRunnerCallResult, toTokenDelta } from '../calls/projection.js';
import type { RunnerCallCompatibleResult } from '../calls/projection.js';
import type { RunnerCallContext, RunnerCallResult } from '../calls/types.js';

type PlannerEscalationConfig = {
  invokeEscalate: (opts: {
    prompt: string;
    projectDir: string;
    callContext: RunnerCallContext;
    callbacks: PlannerOutputCallbacks;
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
  }) => Promise<RunnerCallCompatibleResult>;
  backendKind?: RunnerCallContext['backendKind'];
  runnerName?: string | undefined;
  model?: string | undefined;
  capabilities: { supportsHintEscalation: boolean };
  hintSuccessMode?: 'text' | 'files';
  escalateFullMode?: 'text' | 'files';
  escalateFullPostProcess?: (
    task: Task,
    result: InvokeResult,
    extracted: { code: string },
    projectDir: string,
  ) => EscalationResult;
};

const DEFAULT_BACKEND_KIND: RunnerCallContext['backendKind'] = 'cli';

let escalationCallSequence = 0;

function createEscalationCallContext(config: PlannerEscalationConfig): RunnerCallContext {
  return {
    callId: `escalation-${++escalationCallSequence}`,
    role: 'escalation',
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

export async function escalateHint(
  config: PlannerEscalationConfig,
  opts: EscalateOptions,
): Promise<EscalationResult> {
  const { task, error, projectDir, callbacks, languageContext } = opts;
  if (config.capabilities.supportsHintEscalation === false) {
    return { success: false, output: '', code: null, usage: null };
  }
  const hintPrompt = buildHintPrompt(
    task,
    error,
    languageContext ?? buildProjectLanguageContext(projectDir, undefined),
  );
  const useFiles = config.hintSuccessMode === 'files';
  const detect = useFiles ? createChangeDetector('Hint escalation') : null;
  const baseline = useFiles
    ? await captureChangeDetectorBaseline(projectDir, {
        ignoreProjectDir: opts.fileIgnoreProjectDir,
      })
    : null;
  const callContext = createEscalationCallContext(config);
  const result = requireCompletedCall(
    toRunnerCallResult(
      callContext,
      await config.invokeEscalate({
        prompt: hintPrompt,
        projectDir,
        callContext,
        callbacks,
        signal: callbacks.signal,
        sandboxEnv: opts.sandboxEnv,
      }),
    ),
  );
  const success =
    detect && baseline ? (await detect(projectDir, baseline)).changed : result.text.length > 0;
  return { success, output: result.text, code: null, usage: toTokenDelta(result.usage) };
}

export async function escalateFull(
  config: PlannerEscalationConfig,
  opts: EscalateOptions,
): Promise<EscalationResult> {
  const { task, error, projectDir, callbacks, languageContext } = opts;
  const escalationPrompt = buildEscalationPrompt(
    task,
    task.currentCode ?? '',
    error,
    languageContext ?? buildProjectLanguageContext(projectDir, undefined),
  );

  if (config.escalateFullMode === 'files') {
    const detect = createChangeDetector('Full escalation');
    const baseline = await captureChangeDetectorBaseline(projectDir, {
      ignoreProjectDir: opts.fileIgnoreProjectDir,
    });
    const callContext = createEscalationCallContext(config);
    const result = requireCompletedCall(
      toRunnerCallResult(
        callContext,
        await config.invokeEscalate({
          prompt: escalationPrompt,
          projectDir,
          callContext,
          callbacks,
          signal: callbacks.signal,
          sandboxEnv: opts.sandboxEnv,
        }),
      ),
    );
    const { changed } = await detect(projectDir, baseline);
    return { success: changed, output: result.text, code: null, usage: toTokenDelta(result.usage) };
  }

  const callContext = createEscalationCallContext(config);
  const result = requireCompletedCall(
    toRunnerCallResult(
      callContext,
      await config.invokeEscalate({
        prompt: escalationPrompt,
        projectDir,
        callContext,
        callbacks,
        signal: callbacks.signal,
        sandboxEnv: opts.sandboxEnv,
      }),
    ),
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
