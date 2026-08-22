import type { Config } from '../../../src/core/schemas/config.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
  type RunnerGate,
} from '../../../src/engine/runners/prepared-execution.js';

export function makePreparedExecution(input: {
  projectDir: string;
  sessionId: string;
  feature: string;
  config: Config;
  gates: (preparationId: string) => ReadonlyArray<RunnerGate>;
}): PreparedExecution {
  const preparationId = `${input.sessionId}-preparation`;
  return {
    purpose: 'new-workflow',
    config: parsePreparedConfig(input.config),
    preparationId,
    report: {
      generatedAt: '2026-08-04T00:00:00.000Z',
      projectDir: input.projectDir,
      status: 'ready',
      counts: { ok: 2, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
      sections: [],
      metadata: {},
    },
    gates: input.gates(preparationId),
    session: {
      kind: 'existing',
      ref: { projectDir: input.projectDir, sessionId: input.sessionId },
      active: {
        version: 1,
        sessionId: input.sessionId,
        generation: '7a777777-7777-4777-8777-777777777777',
      },
    },
    runtime: {
      feature: input.feature,
      allowRepoRunners: false,
      allowHooks: false,
    },
  };
}
