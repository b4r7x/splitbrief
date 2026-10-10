import type { Phase } from '../../../core/schemas/enums.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Implementer, ImplementerOptions, RetryOptions } from '../../implementers/types.js';
import type { LanguageContext } from '../../spec/prompts/language-context.js';
import type { ProjectContext } from '../../../core/state/types.js';
import { lineageAttemptsOf } from '../../../core/schemas/workflow.js';
import type { SeatAttempt } from '../../runners/transient.js';
import { addUsageAndSave } from '../state-ops.js';
import {
  absorbBuildCorrections,
  buildCorrectionInput,
  runWithCorrectionPasses,
} from '../queue/build-corrections.js';
import { recordedApiCreatedPaths } from '../evidence/task.js';
import { implementerSeatAttempt, runSeatCall } from './seat-wait.js';
import type { RetryInvokeArgs, RetryInvokeResult } from './types.js';
import { createImplementerTextHandler } from '../events.js';
import type { SteeringPort } from '../../calls/steering.js';
import { settleMidCallDeliveries } from '../queue/mid-call.js';
import { CORRECTION_AFTER_CHECKS } from '../task/brief-gate.js';

export function makeImplementerRetryInvoker(opts: {
  context: ProjectContext;
  kind: RetryOptions['kind'];
  languageContext: LanguageContext;
  sessionId: string;
  phase: Phase;
  implementer?: Implementer | undefined;
  config?: Config | undefined;
  steering?: SteeringPort | undefined;
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
    const effectiveImplementer = opts.implementer ?? implementer;
    const onOutput = createImplementerTextHandler(
      { bus: seat.ref.bus, phase: opts.phase },
      effectiveImplementer,
    );
    let state = seat.state;
    const absorb = (): number => {
      const absorbed = absorbBuildCorrections({ ...seat.ref, state, taskId: task.id });
      state = absorbed.state;
      return absorbed.count;
    };
    const creationOwnership = (): Pick<ImplementerOptions, 'createdByThisTask'> =>
      createdByThisTask === undefined
        ? {}
        : { createdByThisTask: recordedApiCreatedPaths(seat.ref, task, projectDir) };
    const produce = async (attemptSignal: AbortSignal): Promise<SeatAttempt<RetryInvokeResult>> => {
      await settleMidCallDeliveries(seat.ref);
      absorb();
      const call: ImplementerOptions = {
        task,
        ...(opts.steering !== undefined && { steering: opts.steering }),
        projectDir,
        config: effectiveConfig,
        context: opts.context,
        languageContext: opts.languageContext,
        onOutput,
        sessionId: opts.sessionId,
        phase: opts.phase,
        lineageAttempts: lineageAttemptsOf(state, task),
        signal: attemptSignal,
        sandboxEnv,
        fileIgnoreProjectDir,
        changeDetection,
        plan: state.plan,
        ...buildCorrectionInput(state, task),
        allowNoChange: task.fix !== undefined || lastError === CORRECTION_AFTER_CHECKS,
        ...creationOwnership(),
      };
      const result = await runWithCorrectionPasses({
        ref: seat.ref,
        first: () =>
          effectiveImplementer.retry({
            ...call,
            error: lastError,
            attempt: attempts,
            kind: opts.kind,
          }),
        pass: () =>
          effectiveImplementer.implement({
            ...call,
            ...creationOwnership(),
            ...buildCorrectionInput(state, task),
            allowNoChange: true,
          }),
        absorb,
        signal: attemptSignal,
        onDiscardedUsage: (usage) => {
          state = addUsageAndSave(seat.ref, state, seat.usageCategory, usage);
        },
        application: {
          wctx: seat.ref,
          state: () => state,
          task,
          workspacePath: projectDir,
        },
      });
      return implementerSeatAttempt(
        { ...result, runner: effectiveConfig.implementer },
        `The ${opts.kind} retry failed`,
      );
    };

    const attempt = await runSeatCall(
      {
        ref: seat.ref,
        state,
        seat: 'build',
        ...(signal !== undefined && { signal }),
        onStateChange: (next) => {
          state = next;
        },
      },
      produce,
      (discarded) => {
        state = addUsageAndSave(seat.ref, state, seat.usageCategory, discarded.usage);
      },
    );
    return attempt.value;
  };
}
