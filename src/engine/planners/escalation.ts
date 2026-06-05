import type { Task } from '../../core/schemas/task.js';
import type { InvokeResult } from '../runners/types.js';
import { captureChangeDetectorBaseline, createChangeDetector } from '../change-detection.js';
import { extractCode } from '../parsers/response-extractor.js';
import { buildEscalationPrompt, buildHintPrompt } from '../spec/prompts/escalation.js';
import { buildProjectLanguageContext } from '../spec/prompts/language-context.js';
import type { EscalateOptions, EscalationResult, PlannerOutputCallbacks } from './types.js';

type PlannerEscalationConfig = {
  invokeEscalate: (opts: {
    prompt: string;
    projectDir: string;
    callbacks: PlannerOutputCallbacks;
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
  }) => Promise<InvokeResult>;
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
  const result = await config.invokeEscalate({
    prompt: hintPrompt,
    projectDir,
    callbacks,
    signal: callbacks.signal,
    sandboxEnv: opts.sandboxEnv,
  });
  const success =
    detect && baseline ? (await detect(projectDir, baseline)).changed : result.text.length > 0;
  return { success, output: result.text, code: null, usage: result.usage };
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
    const result = await config.invokeEscalate({
      prompt: escalationPrompt,
      projectDir,
      callbacks,
      signal: callbacks.signal,
      sandboxEnv: opts.sandboxEnv,
    });
    const { changed } = await detect(projectDir, baseline);
    return { success: changed, output: result.text, code: null, usage: result.usage };
  }

  const result = await config.invokeEscalate({
    prompt: escalationPrompt,
    projectDir,
    callbacks,
    signal: callbacks.signal,
    sandboxEnv: opts.sandboxEnv,
  });

  const extracted = extractCode(result.text);
  if ('error' in extracted) {
    return { success: false, output: result.text, code: null, usage: result.usage };
  }

  if (config.escalateFullPostProcess) {
    return config.escalateFullPostProcess(task, result, extracted, projectDir);
  }

  return { success: true, output: result.text, code: extracted.code, usage: result.usage };
}
