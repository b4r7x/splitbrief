import { performance } from 'node:perf_hooks';
import { flushEffects } from '../../helpers/ink.js';
import type { CheckpointDefinition, ScenarioDefinition } from '../contracts/catalog.js';
import { formatViewport, type Viewport } from '../contracts/geometry.js';
import type { CheckpointPredicate } from '../fixtures/common.js';
import {
  workflowCheckpointPredicates,
  workflowFixtureProjections,
} from '../fixtures/workflow-fixtures.js';

export interface WaitForCheckpointOptions {
  readonly scenario: ScenarioDefinition;
  readonly checkpoint: CheckpointDefinition;
  readonly viewport: Viewport;
  readonly lastFrame: () => string | undefined;
  readonly predicate?: CheckpointPredicate | undefined;
  readonly timeoutMs?: number | undefined;
}

export async function waitForCheckpoint(options: WaitForCheckpointOptions): Promise<string> {
  const { scenario, checkpoint, viewport, lastFrame } = options;
  const predicate = options.predicate ?? checkpointPredicate(scenario, checkpoint);
  const timeoutMs = parseTimeout(options.timeoutMs ?? checkpoint.timeoutMs, checkpoint.timeoutMs);
  const startedAt = performance.now();

  while (true) {
    await flushEffects();
    const output = lastFrame() ?? '';
    if (predicate({ output, scenario, checkpoint })) return output;
    if (performance.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Checkpoint ${checkpoint.id} was not reached for scenario ${scenario.id} at ${formatViewport(viewport)} within ${timeoutMs}ms`,
      );
    }
  }
}

export function checkpointPredicate(
  scenario: ScenarioDefinition,
  checkpoint: CheckpointDefinition,
): CheckpointPredicate {
  if (workflowFixtureProjections.has(scenario.id)) {
    const predicate = workflowCheckpointPredicates.get(checkpoint.id);
    if (predicate === undefined) {
      throw new Error(
        `No workflow checkpoint predicate for scenario ${scenario.id} and checkpoint ${checkpoint.id}`,
      );
    }
    return predicate;
  }

  return ({ output }) => output.includes(checkpoint.marker);
}

function parseTimeout(value: number, declaredTimeoutMs: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > declaredTimeoutMs) {
    throw new Error(`Checkpoint timeout must be an integer between 1 and ${declaredTimeoutMs}ms`);
  }
  return value;
}
