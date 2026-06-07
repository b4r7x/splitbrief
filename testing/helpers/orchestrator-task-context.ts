import {
  makeCallbacks,
  makeBusRecorder,
  makeImplementer,
  makePlanner,
} from './orchestrator-factories.js';
import { setupGitSessionProject } from './git-session.js';
import { cleanupTempDir } from './temp-dir.js';
import { defaultContext, makeConfig } from './factories/config.js';
import { makeWorkflowMetadata, TEST_WORKFLOW_SINKS } from './orchestrator-context.js';
import type { WorkflowContext } from '../../src/engine/orchestrator/types.js';
import { createValidator } from '../../src/engine/orchestrator/validation.js';

const taskProjectDirs: string[] = [];

export function cleanupTaskProjects(): void {
  for (const dir of taskProjectDirs) cleanupTempDir(dir);
  taskProjectDirs.length = 0;
}

export function setupTaskProject(files: Record<string, string> = {}): {
  projectDir: string;
  sessionId: string;
} {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'task-step-test',
    sessionId: 'sess-task-step',
    files,
  });
  taskProjectDirs.push(projectDir);
  return { projectDir, sessionId };
}

export function makeTaskWorkflowContext(overrides?: Partial<WorkflowContext>): WorkflowContext {
  const proj = overrides?.projectDir
    ? { projectDir: overrides.projectDir, sessionId: overrides.sessionId ?? 'sess-task-step' }
    : setupTaskProject();
  const callbacks = overrides?.callbacks ?? makeCallbacks().callbacks;
  const base: WorkflowContext = {
    projectDir: proj.projectDir,
    sessionId: proj.sessionId,
    config: makeConfig({
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { commitStrategy: 'none', maxRetries: 2 },
    }),
    callbacks,
    bus: makeBusRecorder().bus,
    planner: makePlanner(),
    implementer: makeImplementer(),
    context: { ...defaultContext, dir: proj.projectDir },
    metadata: makeWorkflowMetadata('standard'),
    sinks: TEST_WORKFLOW_SINKS,
    validator: createValidator(),
  };
  return {
    ...base,
    ...overrides,
    projectDir: proj.projectDir,
    sessionId: proj.sessionId,
    callbacks,
  };
}
