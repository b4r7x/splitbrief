import type { Phase } from '../../../core/schemas/enums.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Implementer, RetryOptions } from '../../implementers/types.js';
import type { LanguageContext } from '../../spec/prompts/language-context.js';
import type { ProjectContext } from '../../../core/state/types.js';
import type { RetryInvokeArgs } from './types.js';

export function makeImplementerRetryInvoker(opts: {
  context: ProjectContext;
  kind: RetryOptions['kind'];
  languageContext: LanguageContext;
  phase: Phase;
  onOutput: (text: string) => void;
  implementer?: Implementer | undefined;
  config?: Config | undefined;
}): (args: RetryInvokeArgs) => ReturnType<Implementer['retry']> {
  return ({
    task,
    lastError,
    attempts,
    projectDir,
    implementer,
    config,
    signal,
    sandboxEnv,
    fileIgnoreProjectDir,
    changeDetection,
  }) =>
    (opts.implementer ?? implementer).retry({
      task,
      projectDir,
      config: opts.config ?? config,
      context: opts.context,
      languageContext: opts.languageContext,
      error: lastError,
      attempt: attempts,
      kind: opts.kind,
      onOutput: opts.onOutput,
      phase: opts.phase,
      signal,
      sandboxEnv,
      fileIgnoreProjectDir,
      changeDetection,
    });
}
