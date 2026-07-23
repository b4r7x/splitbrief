import type { ReadinessReport } from '../../src/core/readiness/types.js';
import { WorkflowScreen } from '../../src/app/screens/workflow.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { configStore } from '../../src/stores/project/config.js';
import { terminalSizeStore } from '../../src/stores/ui/terminal-size.js';
import { routerStore } from '../../src/stores/navigation/router.js';
import type { WorkflowScreenDeps } from '../../src/features/workflow/hooks/workflow-screen/use-model.js';

export function readyReadiness(projectDir: string): ReadinessReport {
  return {
    generatedAt: new Date().toISOString(),
    projectDir,
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'ready' },
    sections: [],
    metadata: {},
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
  configStore.__testReset({ config: makeConfig(), projectDir });
  terminalSizeStore.__testReset({ cols: 120, rows, isSmall: false });
  routerStore.navigate({
    to: 'workflow',
    feature,
    readiness: readyReadiness(projectDir),
  });
  return renderFeature(<WorkflowScreen commands={[]} onRuntimeCommand={() => {}} deps={deps} />);
}
