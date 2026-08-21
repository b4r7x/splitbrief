import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type {
  BriefRecoveryProviderPort,
  RecoveryProviderAggregateResult,
  RecoveryProviderRequest,
  RecoveryProviderResult,
} from '../../../core/schemas/brief-recovery.js';
import { PLAN_FILE, SPEC_FILE } from '../../../core/paths.js';
import { readSpecFile } from '../../../core/paths-io.js';
import {
  createTaskCompilationAttemptId,
  type TaskCompilationProgram,
} from '../../../core/schemas/task-compilation.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { narrowRecord } from '../../../utils/type-guards.js';
import { error } from '../../../utils/error.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { materializeTaskCompilationProgram } from '../../spec/tasks/compiler.js';
import {
  readPlannerCompilerRefusal,
  readPlannerCompilerSeam,
  type CompilerSeam,
} from '../../planners/base.js';
import { createBriefRecoveryAggregateProvider } from './brief-recovery-aggregate-provider.js';
import { createBriefRecoveryProvider } from './brief-recovery-provider.js';
import type { WorkflowContext } from '../types.js';

/**
 * One provider decision for the session (REQ-016, REQ-046). A planner that
 * carries the admitted compiler seam dispatches repair/retry through the
 * frozen-program batch path (T-084) on the same operation-wide ledger, so
 * recovery claims count against the same 64-dispatch ceiling as planning. A
 * fail-closed planner refuses recovery with the typed capability code and zero
 * dispatch; everything else (quick/instant, test doubles) keeps the legacy
 * single-call provider.
 */
export function recoveryProviderFor(opts: {
  wctx: WorkflowContext;
  getState: () => WorkflowState;
}): BriefRecoveryProviderPort {
  const seam = readPlannerCompilerSeam(opts.wctx.planner);
  if (seam !== null) {
    return compilerRecoveryProvider(opts, seam);
  }
  if (readPlannerCompilerRefusal(opts.wctx.planner) !== null) {
    return capabilityRefusalRecoveryProvider();
  }
  return createBriefRecoveryProvider({ planner: opts.wctx.planner });
}

function capabilityRefusalRecoveryProvider(): BriefRecoveryProviderPort {
  return {
    dispatch: (request) =>
      Promise.resolve({
        kind: 'definite-failure',
        requestId: request.requestId,
        dispatchPossibility: 'none',
        remoteObservation: 'not-dispatched',
        text: null,
        providerCode: 'task_compiler_capability_unsupported',
        usage: null,
      }),
  };
}

function compilerRecoveryProvider(
  opts: { wctx: WorkflowContext; getState: () => WorkflowState },
  seam: CompilerSeam,
): BriefRecoveryProviderPort {
  const ref = { projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId };
  const aggregate = createBriefRecoveryAggregateProvider({
    ledger: seam.ledger,
    invocation: seam.invocation,
    dispatch: seam.dispatch,
    projectDir: opts.wctx.projectDir,
  });
  return {
    dispatch: (request) =>
      dispatchCompilerRecovery({ request, ref, getState: opts.getState, seam, aggregate }),
  };
}

function dispatchCompilerRecovery(
  input: Readonly<{
    request: RecoveryProviderRequest;
    ref: Readonly<{ projectDir: string; sessionId: string }>;
    getState: () => WorkflowState;
    seam: CompilerSeam;
    aggregate: ReturnType<typeof createBriefRecoveryAggregateProvider>;
  }>,
): Promise<RecoveryProviderResult> {
  const { request, ref, getState, seam, aggregate } = input;
  const languageContext = buildProjectLanguageContext(
    ref.projectDir,
    getState().discoveredValidation?.language,
  ).language;
  let program: TaskCompilationProgram;
  try {
    program = materializeTaskCompilationProgram(
      {
        spec: readSpecFile(ref, SPEC_FILE) ?? getState().feature,
        plan: readSpecFile(ref, PLAN_FILE) ?? '',
        languageContext,
      },
      { envelope: seam.invocation.envelope },
    );
  } catch (thrown) {
    return Promise.resolve({
      kind: 'definite-failure',
      requestId: request.requestId,
      dispatchPossibility: 'none',
      remoteObservation: 'not-dispatched',
      text: null,
      providerCode: materializationFailureCode(thrown),
      usage: null,
    });
  }
  const calls = program.batches.map((batch) => ({
    batchId: batch.batchId,
    attemptId: createTaskCompilationAttemptId(),
    envelopeDigest: sha256Hex(canonicalJSON(batch.envelope)),
  }));
  return aggregate
    .dispatch({
      operationId: seam.ledger.snapshot().operationId,
      program,
      calls,
    })
    .then((result) => aggregateRecoveryResultToSingle(request, result));
}

function aggregateRecoveryResultToSingle(
  request: RecoveryProviderRequest,
  aggregate: RecoveryProviderAggregateResult,
): RecoveryProviderResult {
  const dispatched = aggregate.calls.some((call) => call.kind !== 'not-dispatched');
  switch (aggregate.kind) {
    case 'compiled': {
      const candidate = narrowRecord(aggregate.candidate);
      if (candidate === null || typeof candidate.tasksText !== 'string') {
        throw error('brief-recovery-input-invalid', 'The compiled Brief candidate is invalid.');
      }
      return {
        kind: 'completed',
        requestId: request.requestId,
        dispatchPossibility: 'possible',
        remoteObservation: 'confirmed-final',
        text: candidate.tasksText,
        providerCode: null,
        usage: aggregate.usage,
      };
    }
    case 'ambiguous-failure':
      return {
        kind: 'ambiguous-failure',
        requestId: request.requestId,
        dispatchPossibility: 'possible',
        remoteObservation: 'unknown',
        text: null,
        providerCode: aggregate.failure?.code ?? 'recovery-unknown-outcome',
        usage: aggregate.usage,
      };
    case 'definite-failure':
      return {
        kind: 'definite-failure',
        requestId: request.requestId,
        dispatchPossibility: dispatched ? 'possible' : 'none',
        remoteObservation: dispatched ? 'confirmed-final' : 'not-dispatched',
        text: null,
        providerCode: aggregate.failure?.code ?? 'recovery-dispatch-failed',
        usage: aggregate.usage,
      };
  }
}

function materializationFailureCode(thrown: unknown): string {
  const kind = narrowRecord(thrown)?.kind;
  if (typeof kind === 'string' && kind.startsWith('task_compiler_')) return kind;
  return 'recovery-dispatch-failed';
}
