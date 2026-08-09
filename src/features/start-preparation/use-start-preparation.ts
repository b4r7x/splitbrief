import { useEffect, useRef, useState } from 'react';
import type { ReadinessReport } from '../../core/readiness/types.js';
import {
  releasePreparedExecutionOwnership,
  rollbackPreparedExecutionOwnership,
  type PreparationOutcome,
  type PreparedExecution,
} from '../../engine/runners/prepared-execution.js';

export type StartPreparationState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'preparing' }>
  | Readonly<{
      kind: 'blocked';
      report: ReadinessReport;
    }>
  | Readonly<{
      kind: 'failed';
      report?: ReadinessReport | undefined;
      error: Error;
    }>;

export type StartPreparationOptions<Input> = Readonly<{
  prepare: (input: Input, signal: AbortSignal) => Promise<PreparationOutcome>;
  /** Synchronous route handoff invoked only after new-session ownership is released. */
  onPrepared: (execution: PreparedExecution, input: Input) => void;
}>;

type ActiveAttempt = Readonly<{
  id: number;
  controller: AbortController;
  promise: Promise<void>;
}>;

export type HomeComposerDraftRestore = Readonly<{
  epoch: number;
  value: string;
}>;

export type StartPreparationController<Input> = Readonly<{
  state: StartPreparationState;
  draftRestore: HomeComposerDraftRestore | undefined;
  submit: (input: Input) => Promise<void>;
  retry: () => Promise<void>;
  cancel: (afterCancel?: (() => void) | undefined) => void;
}>;

function preparationError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error('Tool preparation failed.');
}

export function useStartPreparation<Input>(
  options: StartPreparationOptions<Input>,
): StartPreparationController<Input> {
  const [state, setState] = useState<StartPreparationState>({ kind: 'idle' });
  const [draftRestore, setDraftRestore] = useState<HomeComposerDraftRestore | undefined>(undefined);
  const activeRef = useRef<ActiveAttempt | undefined>(undefined);
  const lastInputRef = useRef<Readonly<{ value: Input }> | undefined>(undefined);
  const attemptRef = useRef(0);
  const draftRestoreEpochRef = useRef(0);
  const mountedRef = useRef(true);
  const completedRef = useRef(false);

  const publishDraftRestore = (value: string): void => {
    draftRestoreEpochRef.current += 1;
    setDraftRestore({ epoch: draftRestoreEpochRef.current, value });
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      attemptRef.current += 1;
      activeRef.current?.controller.abort();
      activeRef.current = undefined;
    };
  }, []);

  const isCurrent = (id: number, controller: AbortController): boolean => {
    const active = activeRef.current;
    return (
      mountedRef.current &&
      attemptRef.current === id &&
      active?.id === id &&
      active.controller === controller &&
      !controller.signal.aborted
    );
  };

  const begin = (input: Input): Promise<void> => {
    activeRef.current?.controller.abort();
    const attemptOptions = options;
    const controller = new AbortController();
    const id = attemptRef.current + 1;
    attemptRef.current = id;
    lastInputRef.current = { value: input };
    publishDraftRestore(String(input));
    setState({ kind: 'preparing' });

    const promise = Promise.resolve()
      .then(() => attemptOptions.prepare(input, controller.signal))
      .then(
        (outcome) => {
          if (!isCurrent(id, controller)) {
            if (outcome.kind === 'prepared') rollbackPreparedExecutionOwnership(outcome.execution);
            return;
          }

          switch (outcome.kind) {
            case 'prepared':
              try {
                releasePreparedExecutionOwnership(outcome.execution);
                attemptOptions.onPrepared(outcome.execution, input);
                completedRef.current = true;
              } catch (cause) {
                setState({
                  kind: 'failed',
                  report: outcome.execution.report,
                  error: preparationError(cause),
                });
              }
              return;
            case 'blocked':
              setState({ kind: 'blocked', report: outcome.report });
              return;
            case 'failed':
              setState({
                kind: 'failed',
                ...(outcome.report !== undefined && { report: outcome.report }),
                error: outcome.error,
              });
              return;
            case 'aborted':
              setState({ kind: 'idle' });
              return;
          }
        },
        (cause: unknown) => {
          if (!isCurrent(id, controller)) return;
          setState({ kind: 'failed', error: preparationError(cause) });
        },
      )
      .finally(() => {
        if (activeRef.current?.id === id) activeRef.current = undefined;
      });

    activeRef.current = { id, controller, promise };
    return promise;
  };

  const submit = (input: Input): Promise<void> => {
    const active = activeRef.current;
    // The composer clears its draft on every submit, so a repeat submit the
    // running attempt swallows still has to republish it — otherwise the text
    // the user can still see vanishes without ever reaching a new attempt.
    if (active) {
      publishDraftRestore(String(input));
      return active.promise;
    }
    if (completedRef.current) return Promise.resolve();
    return begin(input);
  };

  const retry = (): Promise<void> => {
    if (completedRef.current) return Promise.resolve();
    const lastInput = lastInputRef.current;
    if (!lastInput) return Promise.resolve();
    return begin(lastInput.value);
  };

  const cancel = (afterCancel?: (() => void) | undefined): void => {
    attemptRef.current += 1;
    activeRef.current?.controller.abort();
    activeRef.current = undefined;
    const lastInput = lastInputRef.current;
    if (mountedRef.current) {
      if (lastInput !== undefined) publishDraftRestore(String(lastInput.value));
      setState({ kind: 'idle' });
    }
    afterCancel?.();
  };

  return { state, draftRestore, submit, retry, cancel };
}
