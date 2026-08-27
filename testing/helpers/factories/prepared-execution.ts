import { resolveImplementerProfiles } from '../../../src/core/config/accessors/implementer-profiles.js';
import type { Config } from '../../../src/core/schemas/config.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { ActiveSessionReceipt } from '../../../src/core/sessions/active-pointer.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
  type RunnerGate,
} from '../../../src/engine/runners/prepared-execution.js';
import { makeRunnerGate } from '../runner-gate.js';

function seatGates(config: Config, preparationId: string): ReadonlyArray<RunnerGate> {
  return [
    makeRunnerGate(config.planner, { role: 'planner' }, preparationId),
    ...resolveImplementerProfiles(config).profiles.map((profile) =>
      makeRunnerGate(profile.config, { role: 'implementer', profile: profile.name }, preparationId),
    ),
  ];
}

export function makePreparedExecution(input: {
  projectDir: string;
  sessionId: string;
  feature: string;
  config: Config;
  gates?: ((preparationId: string) => ReadonlyArray<RunnerGate>) | undefined;
  preparationId?: string | undefined;
  active?: ActiveSessionReceipt | undefined;
  resumeState?: WorkflowState | undefined;
  purpose?: PreparedExecution['purpose'] | undefined;
  allowHooks?: boolean | undefined;
}): PreparedExecution {
  const config = parsePreparedConfig(input.config);
  const preparationId = input.preparationId ?? `${input.sessionId}-preparation`;
  const gates = input.gates?.(preparationId) ?? seatGates(config, preparationId);
  return {
    purpose: input.purpose ?? (input.resumeState === undefined ? 'new-workflow' : 'resume'),
    config,
    preparationId,
    report: {
      generatedAt: '2026-08-04T00:00:00.000Z',
      projectDir: input.projectDir,
      status: 'ready',
      counts: { ok: gates.length, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
      sections: [],
      metadata: {},
    },
    gates,
    session: {
      kind: 'existing',
      ref: { projectDir: input.projectDir, sessionId: input.sessionId },
      active: input.active ?? {
        version: 1,
        sessionId: input.sessionId,
        generation: '7a777777-7777-4777-8777-777777777777',
      },
    },
    runtime: {
      feature: input.feature,
      ...(input.resumeState !== undefined && { resumeState: input.resumeState }),
      allowRepoRunners: false,
      allowHooks: input.allowHooks ?? false,
    },
  };
}
