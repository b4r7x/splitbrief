import { ConfigSchema, type Config } from '../../core/schemas/config.js';
import type { AttachedInput } from '../../core/schemas/attachment.js';
import type { ReadinessReport } from '../../core/readiness/types.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import type {
  ActiveSessionReceipt,
  SessionOwnershipReceipt,
} from '../../core/sessions/active-pointer.js';
import { releasePreparedSession, rollbackPreparedSession } from '../../core/sessions/prepare.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';
import type { CliExecutableReceipt } from '../../core/discovery/detection.js';
import type { DeepReadonly, RunnerConfigSlot } from '../../core/config/accessors/runner-config.js';
import type { AdmittedCustomRunnerInvocation } from './custom-launchability.js';

export type RunnerSlot = RunnerConfigSlot;

/** The parsed configuration object graph frozen at the preparation boundary. */
export type PreparedConfig = Config & DeepReadonly<Config>;

export type CommandGate =
  | Readonly<{ kind: 'validated-config' }>
  | Readonly<{ kind: 'configured-custom'; invocation: AdmittedCustomRunnerInvocation }>;

type RunnerGateBase = Readonly<{
  slot: RunnerSlot;
  preparationId: string;
}>;

export type RunnerGate =
  | (RunnerGateBase &
      Readonly<{
        kind: 'cli';
        tool: CliToolId;
        executable: CliExecutableReceipt;
        /** Absent when the gate was not built from readiness evidence (conformance harness). */
        installedVersion?: string | undefined;
        /**
         * What the seat's `auto` resolved to: the model this tool had selected
         * on this host at preparation. Absent when the seat named a model, or
         * when the tool keeps no selection this machine can read.
         */
        effectiveModel?: string | undefined;
      }>)
  | (RunnerGateBase & Readonly<{ kind: 'api'; provider: string; endpointOrigin: string }>)
  | (RunnerGateBase & Readonly<{ kind: 'shell'; command: CommandGate }>)
  | (RunnerGateBase & Readonly<{ kind: 'agent'; command: CommandGate }>);

export type CommandGateExpectation =
  | Readonly<{ kind: 'validated-config' }>
  | Readonly<{
      kind: 'configured-custom';
      definitionId: AdmittedCustomRunnerInvocation['scope']['definitionId'];
    }>;

export type RunnerGateExpectation =
  | (RunnerGateBase & Readonly<{ kind: 'cli'; tool: CliToolId }>)
  | (RunnerGateBase & Readonly<{ kind: 'api'; provider: string; endpointOrigin: string }>)
  | (RunnerGateBase & Readonly<{ kind: 'shell'; command: CommandGateExpectation }>)
  | (RunnerGateBase & Readonly<{ kind: 'agent'; command: CommandGateExpectation }>);

export type PreparedExecutionSession =
  | Readonly<{
      kind: 'new';
      ref: SessionRef;
      ownership: SessionOwnershipReceipt;
      active: ActiveSessionReceipt;
    }>
  | Readonly<{
      kind: 'existing';
      ref: SessionRef;
      active: ActiveSessionReceipt;
    }>;

export type PreparedExecution = Readonly<{
  purpose: 'new-workflow' | 'resume' | 'spec';
  config: PreparedConfig;
  /** The config this preparation read, before it named the model each seat leaves to its tool. */
  sourceConfig: PreparedConfig;
  preparationId: string;
  report: ReadinessReport;
  gates: ReadonlyArray<RunnerGate>;
  session: PreparedExecutionSession;
  runtime: Readonly<{
    feature: string;
    plannerContext?: string | undefined;
    attachedInputs?: readonly AttachedInput[] | undefined;
    resumeState?: WorkflowState | undefined;
    allowRepoRunners: boolean;
    allowHooks: boolean;
    worktreeName?: string | undefined;
  }>;
}>;

/**
 * A one-shot review admits the review seat and nothing else. It plans nothing,
 * owns no session and writes no state, so its prepared record carries only what
 * the reviewer construction reads — there is no session to release or roll back.
 */
export type PreparedReviewExecution = Readonly<{
  purpose: 'review';
  config: PreparedConfig;
  preparationId: string;
  report: ReadinessReport;
  gates: ReadonlyArray<RunnerGate>;
}>;

export type PreparationOutcome<Execution = PreparedExecution> =
  | Readonly<{ kind: 'prepared'; execution: Execution }>
  | Readonly<{ kind: 'blocked'; report: ReadinessReport }>
  | Readonly<{ kind: 'failed'; report?: ReadinessReport | undefined; error: Error }>
  | Readonly<{ kind: 'aborted' }>;

function freezeRecursively<T>(value: T): asserts value is T & DeepReadonly<T> {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeRecursively(child);
  Object.freeze(value);
}

export function parsePreparedConfig(input: unknown): PreparedConfig {
  const config = ConfigSchema.parse(input);
  freezeRecursively(config);
  return config;
}

export function releasePreparedExecutionOwnership(execution: PreparedExecution): void {
  if (execution.session.kind !== 'new') return;
  const owned = { ref: execution.session.ref, ownership: execution.session.ownership };
  try {
    releasePreparedSession(owned);
  } catch (cause) {
    rollbackPreparedSession(owned);
    throw cause;
  }
}

export function rollbackPreparedExecutionOwnership(execution: PreparedExecution): void {
  if (execution.session.kind !== 'new') return;
  rollbackPreparedSession({
    ref: execution.session.ref,
    ownership: execution.session.ownership,
  });
}
