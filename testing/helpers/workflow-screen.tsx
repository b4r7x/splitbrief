import { WorkflowScreen } from '../../src/app/screens/workflow.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import { resolveImplementerProfiles } from '../../src/core/config/accessors/implementer-profiles.js';
import type { Config } from '../../src/core/schemas/config.js';
import type { WorkflowState } from '../../src/core/schemas/workflow.js';
import {
  createSessionPreparationCandidate,
  prepareNewSession,
} from '../../src/core/sessions/prepare.js';
import { reactivateExistingSession } from '../../src/core/sessions/active-pointer.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
  type RunnerGate,
} from '../../src/engine/runners/prepared-execution.js';
import { configStore } from '../../src/stores/project/config.js';
import { terminalSizeStore } from '../../src/stores/ui/terminal-size.js';
import { routerStore } from '../../src/stores/navigation/router.js';
import type { WorkflowScreenDeps } from '../../src/features/workflow/hooks/workflow-screen/use-model.js';

export function prepareWorkflowExecution({
  projectDir,
  feature,
  config = makeConfig(),
  sessionId = 'workflow-screen-session',
  resumeState,
}: {
  projectDir: string;
  feature: string;
  config?: Config;
  sessionId?: string;
  resumeState?: WorkflowState | undefined;
}): PreparedExecution {
  const preparedConfig = parsePreparedConfig(config);
  const preparationId = `workflow-screen-${sessionId}`;
  const gates: readonly RunnerGate[] = [
    makeRunnerGate(preparedConfig.planner, { role: 'planner' }, preparationId),
    ...resolveImplementerProfiles(preparedConfig).profiles.map((profile) =>
      makeRunnerGate(profile.config, { role: 'implementer', profile: profile.name }, preparationId),
    ),
  ];
  const report = {
    generatedAt: '2026-08-04T00:00:00.000Z',
    projectDir,
    status: 'ready' as const,
    counts: { ok: gates.length, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue' as const, label: 'Continue', reason: 'Ready' },
    sections: [],
    metadata: {},
  };
  const ref = { projectDir, sessionId };
  let session: PreparedExecution['session'];
  if (resumeState === undefined) {
    const preparedSession = prepareNewSession({
      projectDir,
      feature,
      config: preparedConfig,
      report,
      candidate: createSessionPreparationCandidate({
        projectDir,
        feature,
        sessionId,
      }),
    });
    if (preparedSession.kind === 'aborted') {
      throw new Error('Workflow test preparation was aborted');
    }
    session = { kind: 'new', ...preparedSession.session };
  } else {
    session = { kind: 'existing', ref, active: reactivateExistingSession(ref) };
  }

  return {
    purpose: resumeState === undefined ? 'new-workflow' : 'resume',
    config: preparedConfig,
    preparationId,
    report,
    gates,
    session,
    runtime: {
      feature,
      ...(resumeState !== undefined && { resumeState }),
      allowRepoRunners: false,
      allowHooks: false,
    },
  };
}

export function mountWorkflowScreen({
  deps,
  projectDir,
  rows = 60,
  feature = 'screen test feature',
}: {
  deps: WorkflowScreenDeps;
  projectDir: string;
  rows?: number;
  feature?: string;
}) {
  const config = makeConfig();
  const prepared = prepareWorkflowExecution({ projectDir, feature, config });
  const viewport = { cols: 120, rows };
  configStore.__testReset({ config, projectDir });
  terminalSizeStore.__testReset({ ...viewport, isSmall: false });
  // A local route always carries the record of the run its execution prepared, exactly as
  // `splitbrief start` and a continuation build it; a record naming another run would point every
  // confined artifact read at the wrong session directory.
  routerStore.navigate({
    to: 'workflow',
    run: makeRunRecord({ ref: prepared.session.ref, feature }),
    execution: { kind: 'local', prepared },
  });
  // Ink drops every unpainted cell past its stdout's width, margins included, so the screen is
  // painted at the width the store lays it out at.
  return renderFeature(
    <WorkflowScreen commands={[]} onRuntimeCommand={() => {}} deps={deps} />,
    viewport,
  );
}
