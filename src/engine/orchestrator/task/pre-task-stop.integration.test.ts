import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeBusRecorder,
  makeImplementer,
  openRunWorkspace,
} from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
  setupTaskProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../../events/workflow-cancel.js';
import { runSingleTask } from './step.js';

let trustHome: ReturnType<typeof useTrustHome>;
let markerDir: string;

beforeEach(() => {
  trustHome = useTrustHome('pre-task-stop-trust-home');
  markerDir = createTempDir('pre-task-stop-marker');
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTaskProjects();
  cleanupTempDir(markerDir);
  trustHome.restore();
});

describe('runSingleTask — a stop during the pre_task hook', () => {
  it('stops a pre_task hook with no time limit and dispatches nothing', async () => {
    const { projectDir, sessionId } = setupTaskProject();
    const startedFile = join(markerDir, 'started');
    writeFileSync(
      join(projectDir, 'wait-pre-task.mjs'),
      [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync(process.argv[2], 'started\\n');",
        'setInterval(() => {}, 1 << 30);',
        '',
      ].join('\n'),
    );
    const hooks: HooksConfig = {
      pre_task: [
        {
          kind: 'command',
          command: 'node',
          args: ['wait-pre-task.mjs', startedFile],
          on_failure: 'block',
        },
      ],
    };
    markHooksConfigTrusted(projectDir, hooks);
    const task = makeTask({ id: 'T001', action: 'create', suggestedFiles: ['src/hello.ts'] });
    const implementer = makeImplementer();
    const { bus, events } = makeBusRecorder();
    const controller = new AbortController();
    const wctx = await openRunWorkspace(
      makeTaskWorkflowContext({
        projectDir,
        sessionId,
        implementer,
        bus,
        signal: controller.signal,
        config: makeConfig({ hooks }),
      }),
    );

    const pending = runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state: implementingState([task]),
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });
    await vi.waitFor(
      () => {
        expect(readFileSync(startedFile, 'utf8')).toBe('started\n');
      },
      { timeout: 10_000, interval: 20 },
    );
    controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
    const result = await pending;

    expect(implementer.implement).not.toHaveBeenCalled();
    expect(result.tasks[0]?.status).not.toBe('skipped');
    expect(events.map((e) => e.type)).not.toContain('task_started');
    expect(events.map((e) => e.type)).not.toContain('task_skipped');
    expect(events.filter((e) => e.type === 'warning' && e.message.includes('pre_task'))).toEqual(
      [],
    );
  });
});
