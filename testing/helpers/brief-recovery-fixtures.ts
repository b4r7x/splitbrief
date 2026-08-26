import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_FILE, sessionDir } from '../../src/core/paths.js';
import type { NormalBriefRecoveryV1 } from '../../src/core/schemas/brief-recovery/document.js';
import type { WorkflowState } from '../../src/core/schemas/workflow.js';
import { createInitialState } from '../../src/core/state/machine.js';
import { saveState } from '../../src/core/state/persistence.js';
import type { StateAuthorityReceipt } from '../../src/core/state/types.js';
import type { SessionRef } from '../../src/core/types/session-ref.js';
import type { Planner } from '../../src/engine/planners/types.js';
import type { ModelCacheAccessor } from '../../src/engine/providers/model/resolution.js';
import { createWorkflowRecoveryBinding } from '../../src/engine/orchestrator/run/recovery-binding.js';
import {
  type WorkflowStateHead,
  readWorkflowStateHead,
  workflowStateRevision,
} from '../../src/engine/orchestrator/state-ops.js';
import { makeConfig } from './factories/config.js';
import { makeWctx } from './orchestrator-factories.js';
import { makePassingPlanner, setupProject, TEST_METADATA } from './planning-phase.js';

export const PRICED_MODEL_CACHE = {
  getModelsDevCatalog: () => ({
    openai: {
      id: 'openai',
      models: {
        'gpt-5.4': {
          id: 'gpt-5.4',
          cost: { input: 2.5, output: 15 },
          limit: { context: 400_000 },
        },
      },
    },
  }),
  getProviderModels: () => null,
};

export type BindingFixture = {
  binding: ReturnType<typeof createWorkflowRecoveryBinding>;
  ref: SessionRef;
  authority: () => StateAuthorityReceipt;
  trackedState: () => WorkflowState;
};

interface RecoveryBindingOptions {
  ref: SessionRef;
  ownerId: string;
  planner?: Planner | undefined;
  modelCache?: ModelCacheAccessor | undefined;
  maxBudget?: number | undefined;
  model?: string | undefined;
}

type RecoveryFixtureOptions = Omit<RecoveryBindingOptions, 'ref'> & {
  dirs: string[];
  mode?: WorkflowState['mode'] | undefined;
};

export function stateBytes(ref: SessionRef): string {
  return readFileSync(join(sessionDir(ref.projectDir, ref.sessionId), STATE_FILE), 'utf8');
}

export function normalRecovery(state: WorkflowState): NormalBriefRecoveryV1 {
  const recovery = state.briefRecovery;
  if (recovery === null || recovery === undefined || !('attempts' in recovery))
    throw new Error('expected a normal recovery');
  return recovery;
}

export function recoveryOwnerExpectation(opts: {
  head: WorkflowStateHead;
  authorityRevision: number;
}) {
  const recovery = opts.head.state.briefRecovery;
  if (recovery === null || recovery === undefined)
    throw new Error('expected a recovery in the persisted head');
  return {
    epochId: recovery.epochId,
    stateRevision: opts.head.revision,
    authorityRevision: opts.authorityRevision,
    fence: String(opts.head.state.stateFence?.token ?? 0),
    evidenceHead: recovery.evidenceHead,
  };
}

function authorityFor(opts: {
  state: WorkflowState;
  digest: string;
  ref: SessionRef;
  ownerId: string;
}): StateAuthorityReceipt {
  const { state, ownerId } = opts;
  return {
    kind: 'usable',
    sessionId: opts.ref.sessionId,
    ownerId: state.stateFence?.ownerId ?? ownerId,
    pid: process.pid,
    processStart: `${ownerId}-process`,
    runId: `${ownerId}-run`,
    acquisitionId: `${ownerId}-acquisition`,
    fence: state.stateFence?.token ?? 0,
    stateRevision: workflowStateRevision(state),
    stateDigest: opts.digest,
  };
}

export function makeRecoveryBinding(options: RecoveryBindingOptions): BindingFixture {
  const { ref, ownerId } = options;
  const initialHead = readWorkflowStateHead(ref);
  if (initialHead === null) throw new Error('expected the initial workflow head');
  const wctx = makeWctx({
    projectDir: ref.projectDir,
    sessionId: ref.sessionId,
    config: makeConfig({
      planner: {
        kind: 'api',
        provider: 'openai',
        service: 'openai',
        offering: 'payg',
        apiBase: 'https://api.openai.com/v1',
        model: options.model ?? 'gpt-5.4',
      },
      workflow: {
        ...(options.maxBudget === undefined ? {} : { maxBudget: options.maxBudget }),
      },
    }),
    planner: options.planner ?? makePassingPlanner(),
    ...(options.modelCache === undefined ? {} : { modelCache: options.modelCache }),
    metadata: TEST_METADATA,
  });
  let trackedState: WorkflowState = initialHead.state;
  let authority = authorityFor({
    state: initialHead.state,
    digest: initialHead.digest,
    ref,
    ownerId,
  });
  const binding = createWorkflowRecoveryBinding({
    wctx,
    getState: () => trackedState,
    setState: (next) => {
      trackedState = next;
      const head = readWorkflowStateHead(ref);
      if (head === null) throw new Error('expected the committed workflow head');
      authority = {
        ...authority,
        stateRevision: workflowStateRevision(next),
        stateDigest: head.digest,
      };
    },
    getAuthority: () => authority,
  });
  return { binding, ref, authority: () => authority, trackedState: () => trackedState };
}

export function makeRecoveryBindingFixture(options: RecoveryFixtureOptions): BindingFixture {
  const { projectDir, sessionId } = setupProject(options.dirs);
  const ref = { projectDir, sessionId };
  saveState(ref, {
    ...createInitialState(options.ownerId),
    stateFence: { token: 1, ownerId: options.ownerId },
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });
  return makeRecoveryBinding({ ...options, ref });
}
