import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadOwnerWorkflowState } from '../../src/core/state/resume-hydration.js';
import type { Implementer } from '../../src/engine/implementers/types.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../../src/engine/events/workflow-cancel.js';
import { runWorkflow } from '../../src/engine/orchestrator/run/workflow.js';
import { ONE_SHOT_API_CAPS, type Planner } from '../../src/engine/planners/types.js';
import type { PreparedExecution } from '../../src/engine/runners/prepare-execution/prepared.js';
import { testCliSeats } from './runner-gate.js';

async function observeResume(input: {
  prepared: Omit<PreparedExecution, 'cliSeats'>;
  watched: string[];
  output: string;
}): Promise<void> {
  const { prepared, watched, output } = input;
  const kept = loadOwnerWorkflowState(prepared.session.ref);
  if (kept.kind !== 'loaded') throw new Error('The run did not leave a state to resume');

  const controller = new AbortController();
  const observed: {
    beforeSecondCall: Record<string, string | null>;
    ignoredBeforeSecondCall: string | null;
  }[] = [];
  const unavailableCall = (): never => {
    throw new Error('Unexpected call while observing the resumed attempt');
  };
  const runner = { isAvailable: async () => true, getVersion: async () => '1.0' };
  const planner: Planner = {
    ...runner,
    capabilities: ONE_SHOT_API_CAPS,
    review: unavailableCall,
    summarize: unavailableCall,
    typedCall: unavailableCall,
  };
  const implementer: Implementer = {
    ...runner,
    implement: async ({ projectDir }) => {
      const contents = (path: string) => {
        const file = join(projectDir, path);
        return existsSync(file) ? readFileSync(file, 'utf8') : null;
      };
      observed.push({
        beforeSecondCall: Object.fromEntries(watched.map((path) => [path, contents(path)])),
        ignoredBeforeSecondCall: contents('build/out.log'),
      });
      controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
      return { success: true, output: '' };
    },
    retry: unavailableCall,
  };
  await runWorkflow({
    prepared: { ...prepared, cliSeats: testCliSeats(prepared.gates) },
    savedState: kept.state,
    signal: controller.signal,
    callbacks: { onApprovalNeeded: async () => ({ approved: true }), onComplete: () => {} },
    sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    _planner: planner,
    _implementer: implementer,
  });
  writeFileSync(output, JSON.stringify(observed));
}

await observeResume(JSON.parse(process.argv[2] ?? ''));
