import type {
  BriefRecoveryProviderPort,
  RecoveryProviderRequest,
  RecoveryProviderResult,
  RecoveryUsage,
} from '../../../core/schemas/brief-recovery.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { Planner } from '../../planners/types.js';
import type {
  RunnerCallContext,
  RunnerCallEvent,
  RunnerCallStatus,
  RunnerCallUsage,
} from '../../calls/types.js';
import { applyRunnerCallUsageSample } from '../../calls/usage.js';
import { isRecord } from '../../../utils/type-guards.js';
import { isSafeTokenUsage, stringValue, toRecoveryUsage } from './brief-recovery-guards.js';

const DUPLICATE_OPERATION_CODE = 'duplicate-operation';
const ABORTED_CODE = 'aborted';
const TIMEOUT_CODE = 'timeout';
const IDENTITY_CONFLICT_CODE = 'runner-call-identity-conflict';
const UNKNOWN_OUTCOME_CODE = 'recovery-unknown-outcome';
const DISPATCH_FAILURE_CODE = 'recovery-dispatch-failed';
const MAX_PROVIDER_CODE_LENGTH = 256;

/** A normalized runner event with the recovery operation that accepted it. */
export type BriefRecoveryCallEvent = RunnerCallEvent & {
  sessionId: string;
  epochId: string;
  operationId: string;
  requestId: string;
};

export type BriefRecoveryProviderOptions = {
  planner: Planner;
  onOutput?: ((text: string) => void) | undefined;
  onCallEvent?: ((event: BriefRecoveryCallEvent) => void) | undefined;
};

type OperationObservation = {
  dispatchFenced: boolean;
  identity: RunnerCallContext | null;
  identityConflict: boolean;
  terminalStatus: RunnerCallStatus | null;
  terminalCode: string | null;
  usage: RunnerCallUsage | null;
  usageInvalid: boolean;
};

type PlannerOutcome =
  | { kind: 'completed'; result: { text: string; usage: TokenDelta | null } }
  | { kind: 'failed'; error: unknown };

type AbortOutcome = { kind: 'aborted'; code: typeof ABORTED_CODE | typeof TIMEOUT_CODE };

type ErrorDetails = {
  code: string | null;
  status: RunnerCallStatus | null;
};

/**
 * Wraps the unchanged Planner.review port in the one-shot recovery boundary.
 * The operation map is deliberately local to one provider instance: callers that need replay
 * protection across transports share this adapter instance, while a fresh operation ID is needed
 * for every later remote attempt.
 */
export function createBriefRecoveryProvider(
  options: BriefRecoveryProviderOptions,
): BriefRecoveryProviderPort {
  const acceptedOperations = new Set<string>();

  return {
    dispatch(input) {
      const operationKey = operationKeyFor(input);
      if (acceptedOperations.has(operationKey)) {
        return Promise.resolve(definiteFailure(input, DUPLICATE_OPERATION_CODE, 'none', null));
      }
      acceptedOperations.add(operationKey);
      return dispatchOnce(options, input);
    },
  };
}

async function dispatchOnce(
  options: BriefRecoveryProviderOptions,
  input: RecoveryProviderRequest,
): Promise<RecoveryProviderResult> {
  const signal = narrowAbortSignal(input.signal);
  if (signal?.aborted === true) {
    return definiteFailure(input, abortCode(signal), 'none', null);
  }

  const observation: OperationObservation = {
    dispatchFenced: false,
    identity: null,
    identityConflict: false,
    terminalStatus: null,
    terminalCode: null,
    usage: null,
    usageInvalid: false,
  };

  const plannerCallbacks = {
    onOutput: options.onOutput ?? (() => {}),
    ...(signal !== undefined && { signal }),
    onCallEvent: (event: RunnerCallEvent): void => {
      observeEvent(observation, event);
      const boundEvent: BriefRecoveryCallEvent = {
        ...event,
        sessionId: input.sessionId,
        epochId: input.epochId,
        operationId: input.operationId,
        requestId: input.requestId,
      };
      options.onCallEvent?.(boundEvent);
    },
  };

  let plannerPromise: Promise<{ text: string; usage: TokenDelta | null }>;
  try {
    plannerPromise = options.planner.review(input.prompt, input.projectDir, plannerCallbacks);
  } catch (error: unknown) {
    return classifyFailure(input, observation, error);
  }

  const outcomePromise: Promise<PlannerOutcome> = plannerPromise.then(
    (result) => ({ kind: 'completed', result }),
    (error: unknown) => ({ kind: 'failed', error }),
  );

  if (signal === undefined) {
    return settlePlannerOutcome(input, observation, await outcomePromise);
  }

  let removeAbortListener = (): void => {};
  const abortPromise = new Promise<AbortOutcome>((resolve) => {
    const onAbort = (): void => resolve({ kind: 'aborted', code: abortCode(signal) });
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
  });

  const outcome = await Promise.race([outcomePromise, abortPromise]);
  removeAbortListener();
  if (outcome.kind === 'aborted') {
    return classifyAbort(input, observation, outcome.code);
  }
  return settlePlannerOutcome(input, observation, outcome);
}

function settlePlannerOutcome(
  input: RecoveryProviderRequest,
  observation: OperationObservation,
  outcome: PlannerOutcome,
): RecoveryProviderResult {
  if (outcome.kind === 'completed') {
    if (observation.identityConflict && observation.dispatchFenced) {
      return ambiguousFailure(input, IDENTITY_CONFLICT_CODE, observedUsage(observation));
    }
    if (observation.terminalStatus !== null && observation.terminalStatus !== 'completed') {
      return classifyTerminalFailure(input, observation, observation.terminalCode);
    }
    const outcomeUsage = toRecoveryUsage(outcome.result.usage);
    const outcomeUsageInvalid = outcome.result.usage !== null && outcomeUsage === null;
    return {
      kind: 'completed',
      requestId: input.requestId,
      dispatchPossibility: 'possible',
      remoteObservation: 'confirmed-final',
      text: outcome.result.text,
      providerCode: null,
      usage:
        observation.usageInvalid || outcomeUsageInvalid
          ? null
          : (toRecoveryUsage(observation.usage) ?? outcomeUsage),
    };
  }

  return classifyFailure(input, observation, outcome.error);
}

function classifyFailure(
  input: RecoveryProviderRequest,
  observation: OperationObservation,
  thrown: unknown,
): RecoveryProviderResult {
  if (observation.identityConflict && observation.dispatchFenced) {
    return ambiguousFailure(input, IDENTITY_CONFLICT_CODE, observedUsage(observation));
  }

  const details = errorDetails(thrown);
  const status = observation.terminalStatus ?? details.status;
  const code =
    observation.terminalCode ??
    details.code ??
    (observation.dispatchFenced ? UNKNOWN_OUTCOME_CODE : DISPATCH_FAILURE_CODE);

  if (!observation.dispatchFenced) {
    return definiteFailure(input, code, 'none', observedUsage(observation));
  }

  if (isAmbiguousAfterDispatch(status, code, thrown)) {
    return ambiguousFailure(input, code, observedUsage(observation));
  }

  if (observation.terminalStatus !== null) {
    return classifyTerminalFailure(input, observation, observation.terminalCode);
  }

  return ambiguousFailure(input, code, observedUsage(observation));
}

function classifyAbort(
  input: RecoveryProviderRequest,
  observation: OperationObservation,
  code: typeof ABORTED_CODE | typeof TIMEOUT_CODE,
): RecoveryProviderResult {
  if (!observation.dispatchFenced) {
    return definiteFailure(input, code, 'none', observedUsage(observation));
  }
  return ambiguousFailure(input, code, observedUsage(observation));
}

function classifyTerminalFailure(
  input: RecoveryProviderRequest,
  observation: OperationObservation,
  terminalCode: string | null,
): RecoveryProviderResult {
  const code = terminalCode ?? DISPATCH_FAILURE_CODE;
  if (isAmbiguousAfterDispatch(observation.terminalStatus, code, undefined)) {
    return ambiguousFailure(input, code, observedUsage(observation));
  }
  return definiteFailure(input, code, 'possible', observedUsage(observation));
}

function observeEvent(observation: OperationObservation, event: RunnerCallEvent): void {
  const identity = contextFromEvent(event);
  if (observation.identity === null) {
    observation.identity = identity;
  } else if (!sameContext(observation.identity, identity)) {
    observation.identityConflict = true;
  }

  if (event.type === 'call_started') observation.dispatchFenced = true;
  if (event.type === 'call_usage') {
    recordUsage(observation, event.usage, event.semantics);
  }
  if (event.type === 'call_completed') {
    observation.terminalStatus = event.status;
    if (event.usage !== null) recordUsage(observation, event.usage, 'final');
  }
  if (event.type === 'call_error') {
    observation.terminalStatus = event.status;
    observation.terminalCode = event.error.code;
    if (event.usage !== null) recordUsage(observation, event.usage, 'final');
  }
}

function recordUsage(
  observation: OperationObservation,
  usage: RunnerCallUsage,
  semantics: 'delta' | 'cumulative' | 'final',
): void {
  if (!isSafeTokenUsage(usage)) {
    observation.usageInvalid = true;
    return;
  }
  try {
    const next = applyRunnerCallUsageSample(observation.usage, { usage, semantics });
    if (!isSafeTokenUsage(next)) {
      observation.usageInvalid = true;
      return;
    }
    observation.usage = next;
  } catch {
    observation.usageInvalid = true;
  }
}

function contextFromEvent(event: RunnerCallEvent): RunnerCallContext {
  return {
    callId: event.callId,
    role: event.role,
    backendKind: event.backendKind,
    ...(event.runnerName !== undefined && { runnerName: event.runnerName }),
    ...(event.model !== undefined && { model: event.model }),
    ...(event.attempt !== undefined && { attempt: event.attempt }),
  };
}

function sameContext(left: RunnerCallContext, right: RunnerCallContext): boolean {
  return (
    left.callId === right.callId &&
    left.role === right.role &&
    left.backendKind === right.backendKind &&
    left.runnerName === right.runnerName &&
    left.model === right.model &&
    left.attempt === right.attempt
  );
}

function isAmbiguousAfterDispatch(
  status: RunnerCallStatus | null,
  code: string,
  thrown: unknown,
): boolean {
  if (status === 'aborted' || status === 'timeout' || status === 'incomplete') return true;
  if (status === 'truncated') return true;

  const normalizedCode = code.toLowerCase();
  if (
    /(abort|timeout|timed[_-]?out|connection|transport|network|socket|process|eof|broken[_-]?pipe|disconnect|stream[_-]?(?:closed|error)|missing_terminal)/u.test(
      normalizedCode,
    )
  ) {
    return true;
  }

  if (thrown !== undefined) {
    const message = errorMessage(thrown).toLowerCase();
    if (
      /(connection|transport|network|socket|process|eof|broken[_-]?pipe|disconnect|stream.*(?:closed|ended)|timed out)/u.test(
        message,
      )
    ) {
      return true;
    }
  }
  return false;
}

function errorDetails(thrown: unknown): ErrorDetails {
  if (!isRecord(thrown)) return { code: null, status: null };

  const directCode = stringValue(thrown.code) ?? stringValue(thrown.kind);
  const directStatus = runnerCallStatus(thrown.status);
  const data = isRecord(thrown.data) ? thrown.data : null;
  const nestedError = data !== null && isRecord(data.error) ? data.error : null;
  const nestedCode = nestedError === null ? null : stringValue(nestedError.code);
  const nestedStatus = data === null ? null : runnerCallStatus(data.status);
  return {
    code: nestedCode ?? directCode,
    status: nestedStatus ?? directStatus,
  };
}

function runnerCallStatus(value: unknown): RunnerCallStatus | null {
  switch (value) {
    case 'completed':
    case 'failed':
    case 'truncated':
    case 'aborted':
    case 'timeout':
    case 'refused':
    case 'unsupported_tool':
    case 'incomplete':
      return value;
    default:
      return null;
  }
}

function errorMessage(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  if (isRecord(thrown)) return stringValue(thrown.message) ?? '';
  return '';
}

function operationKeyFor(input: RecoveryProviderRequest): string {
  return JSON.stringify([input.sessionId, input.epochId, input.operationId]);
}

function definiteFailure(
  input: RecoveryProviderRequest,
  providerCode: string,
  dispatchPossibility: 'none' | 'possible',
  usage: RunnerCallUsage | null,
): RecoveryProviderResult {
  return {
    kind: 'definite-failure',
    requestId: input.requestId,
    dispatchPossibility,
    remoteObservation: dispatchPossibility === 'none' ? 'not-dispatched' : 'confirmed-final',
    text: null,
    providerCode: boundedProviderCode(providerCode),
    usage: toRecoveryUsage(usage),
  };
}

function ambiguousFailure(
  input: RecoveryProviderRequest,
  providerCode: string,
  usage: RunnerCallUsage | null,
): RecoveryProviderResult {
  return {
    kind: 'ambiguous-failure',
    requestId: input.requestId,
    dispatchPossibility: 'possible',
    remoteObservation: 'unknown',
    text: null,
    providerCode: boundedProviderCode(providerCode || UNKNOWN_OUTCOME_CODE),
    usage: toRecoveryUsage(usage),
  };
}

function observedUsage(observation: OperationObservation): RecoveryUsage | null {
  return observation.usageInvalid ? null : toRecoveryUsage(observation.usage);
}

function boundedProviderCode(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) return DISPATCH_FAILURE_CODE;
  return normalized.slice(0, MAX_PROVIDER_CODE_LENGTH);
}

function narrowAbortSignal(value: unknown): AbortSignal | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal ? value : undefined;
}

function abortCode(signal: AbortSignal): typeof ABORTED_CODE | typeof TIMEOUT_CODE {
  const reason = signal.reason;
  if (isRecord(reason) && reason.name === 'TimeoutError') return TIMEOUT_CODE;
  if (reason instanceof DOMException && reason.name === 'TimeoutError') return TIMEOUT_CODE;
  if (reason instanceof Error && /timeout|timed out/iu.test(reason.message)) return TIMEOUT_CODE;
  if (typeof reason === 'string' && /timeout|timed out/iu.test(reason)) return TIMEOUT_CODE;
  return ABORTED_CODE;
}
