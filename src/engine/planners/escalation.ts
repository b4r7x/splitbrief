import type { Task } from '../../core/schemas/task.js';
import type { InvokeResult } from '../runners/types.js';
import { getCurrentChangedFiles } from '../../lib/git.js';
import { createChangeDetector } from '../change-detection.js';
import { extractCode } from '../parsers/response-extractor.js';
import { buildEscalationPrompt, buildHintPrompt } from '../spec/prompts/escalation.js';
import { buildProjectLanguageContext, type LanguageContext } from '../spec/prompts/language-context.js';
import type { EscalationResult } from './types.js';

type PlannerEscalationConfig = {
  invokeEscalate: (opts: {
    prompt: string;
    projectDir: string;
    callbacks: { onOutput: (text: string) => void };
  }) => Promise<InvokeResult>;
  capabilities: { supportsHintEscalation: boolean };
  hintSuccessMode?: 'text' | 'files';
  escalateFullMode?: 'text' | 'files';
  escalateFullPostProcess?: (task: Task, result: InvokeResult, extracted: { code: string }, projectDir: string) => EscalationResult;
};

export async function escalateHint(
  config: PlannerEscalationConfig,
  task: Task,
  error: string,
  projectDir: string,
  callbacks: { onOutput: (text: string) => void },
  languageContext?: LanguageContext,
): Promise<EscalationResult> {
  if (config.capabilities.supportsHintEscalation === false) {
    return { success: false, output: '', code: null, usage: null };
  }
  const hintPrompt = buildHintPrompt(task, error, languageContext ?? buildProjectLanguageContext(projectDir, undefined));
  const useFiles = config.hintSuccessMode === 'files';
  const detect = useFiles ? createChangeDetector('Hint escalation') : null;
  const filesBefore = useFiles ? await getCurrentChangedFiles(projectDir) : [];
  const result = await config.invokeEscalate({ prompt: hintPrompt, projectDir, callbacks });
  const success = detect
    ? (await detect(projectDir, filesBefore)).changed
    : result.text.length > 0;
  return { success, output: result.text, code: null, usage: result.usage };
}

export async function escalateFull(
  config: PlannerEscalationConfig,
  task: Task,
  error: string,
  projectDir: string,
  callbacks: { onOutput: (text: string) => void },
  languageContext?: LanguageContext,
): Promise<EscalationResult> {
  const escalationPrompt = buildEscalationPrompt(task, task.currentCode ?? '', error, languageContext ?? buildProjectLanguageContext(projectDir, undefined));

  if (config.escalateFullMode === 'files') {
    const detect = createChangeDetector('Full escalation');
    const filesBefore = await getCurrentChangedFiles(projectDir);
    const result = await config.invokeEscalate({ prompt: escalationPrompt, projectDir, callbacks });
    const { changed } = await detect(projectDir, filesBefore);
    return { success: changed, output: result.text, code: null, usage: result.usage };
  }

  const result = await config.invokeEscalate({ prompt: escalationPrompt, projectDir, callbacks });

  const extracted = extractCode(result.text);
  if ('error' in extracted) {
    return { success: false, output: result.text, code: null, usage: result.usage };
  }

  if (config.escalateFullPostProcess) {
    return config.escalateFullPostProcess(task, result, extracted, projectDir);
  }

  return { success: true, output: result.text, code: extracted.code, usage: result.usage };
}
