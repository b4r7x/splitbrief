import { useEffect, useRef } from 'react';
import {
  releasePreparedExecutionOwnership,
  type PreparationOutcome,
  type PreparedExecution,
} from '../../engine/runners/prepare-execution/prepared.js';
import {
  CHECKING_TOOLS_STAGE,
  preparationStore,
  type PreparationViewState,
  preparationView,
} from '../../stores/navigation/preparation.js';

export type StartPreparationOptions<Input> = Readonly<{
  prepare: (input: Input, signal: AbortSignal) => Promise<PreparationOutcome>;
  /** Synchronous route handoff invoked only after new-session ownership is released. */
  onPrepared: (execution: PreparedExecution, input: Input) => void;
}>;

type OwnAttempt = Readonly<{
  attempt: number;
  promise: Promise<void>;
}>;

export type StartPreparationController<Input> = Readonly<{
  state: PreparationViewState;
  submit: (input: Input) => Promise<void>;
  retry: () => Promise<void>;
  cancel: (afterCancel?: (() => void) | undefined) => void;
}>;

/** The screen-side adapter over the shared preparation coordinator. The composer owns its draft. */
export function useStartPreparation<Input>(
  options: StartPreparationOptions<Input>,
): StartPreparationController<Input> {
  const coordinator = preparationStore.use((state) => state);
  const ownRef = useRef<OwnAttempt | undefined>(undefined);
  const lastInputRef = useRef<Readonly<{ value: Input }> | undefined>(undefined);
  const completedRef = useRef(false);

  useEffect(
    () => () => {
      if (ownRef.current) preparationStore.cancel(ownRef.current.attempt);
    },
    [],
  );

  const begin = (input: Input): Promise<void> => {
    const { prepare, onPrepared } = options;
    lastInputRef.current = { value: input };
    const handle = preparationStore.submit({
      origin: 'start',
      stage: CHECKING_TOOLS_STAGE,
      prepare: (signal) => prepare(input, signal),
      onPrepared: (execution) => {
        releasePreparedExecutionOwnership(execution);
        onPrepared(execution, input);
        completedRef.current = true;
      },
    });
    ownRef.current = { attempt: handle.attempt, promise: handle.promise };
    return handle.promise;
  };

  const submit = (input: Input): Promise<void> => {
    const own = ownRef.current;
    const current = preparationStore.get();
    if (own && current.kind === 'checking' && current.attempt === own.attempt) {
      return own.promise;
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

  // Only this screen's current attempt is cancelled; a newer attempt from elsewhere keeps its
  // owner, and the draft and the caller's teardown are left alone.
  const cancel = (afterCancel?: (() => void) | undefined): void => {
    const own = ownRef.current;
    if (own === undefined || !preparationStore.cancel(own.attempt)) return;
    afterCancel?.();
  };

  return {
    state: preparationView(
      coordinator.kind !== 'idle' && coordinator.attempt === ownRef.current?.attempt
        ? coordinator
        : undefined,
    ),
    submit,
    retry,
    cancel,
  };
}
