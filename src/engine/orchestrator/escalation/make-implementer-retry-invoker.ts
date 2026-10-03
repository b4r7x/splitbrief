import type { Phase } from '../../../core/schemas/enums.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Implementer, RetryOptions } from '../../implementers/types.js';
import type { LanguageContext } from '../../spec/prompts/language-context.js';
import type { ProjectContext } from '../../../core/state/types.js';
import type { SeatAttempt } from '../../runners/transient.js';
import { addUsageAndSave } from '../state-ops.js';
import { implementerSeatAttempt, runSeatCall } from './seat-wait.js';
import type { RetryInvokeArgs, RetryInvokeResult } from './types.js';

export function makeImplementerRetryInvoker(opts: {
  context: ProjectContext;
  kind: RetryOptions['kind'];
  languageContext: LanguageContext;
  sessionId: string;
  phase: Phase;
  onOutput: (text: string) => void;
  implementer?: Implementer | undefined;
  config?: Config | undefined;
}): (args: RetryInvokeArgs) => Promise<RetryInvokeResult> {
  return async ({
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
    createdByThisTask,
    seat,
  }) => {
    const effectiveConfig = opts.config ?? config;
    const produce = async (attemptSignal: AbortSignal): Promise<SeatAttempt<RetryInvokeResult>> => {
      const result = await (opts.implementer ?? implementer).retry({
        task,
        projectDir,
        config: effectiveConfig,
        context: opts.context,
        languageContext: opts.languageContext,
        error: lastError,
        attempt: attempts,
        kind: opts.kind,
        onOutput: opts.onOutput,
        sessionId: opts.sessionId,
        phase: opts.phase,
        signal: attemptSignal,
        sandboxEnv,
        fileIgnoreProjectDir,
        changeDetection,
        ...(createdByThisTask === undefined ? {} : { createdByThisTask }),
      });
      return implementerSeatAttempt(
        { ...result, runner: effectiveConfig.implementer },
        `The ${opts.kind} retry failed`,
      );
    };

    const attempt = await runSeatCall(
      {
        ref: seat.ref,
        state: seat.state,
        seat: 'build',
        ...(signal !== undefined && { signal }),
      },
      produce,
      (discarded) => {
        addUsageAndSave(seat.ref, seat.state, seat.usageCategory, discarded.usage);
      },
    );
    return attempt.value;
  };
}
