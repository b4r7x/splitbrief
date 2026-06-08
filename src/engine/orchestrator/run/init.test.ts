import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EngineEvent } from '../../events/types.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import type { SummaryBase } from '../summary.js';
import { initializeWorkflow } from './init.js';

describe('initializeWorkflow', () => {
  it('registers discovered pre-task modules when config has no hooks', async () => {
    await withTempDir('diptych-init-hooks', async (projectDir) => {
      const hooksDir = join(projectDir, '.diptych', 'hooks');
      await mkdir(hooksDir, { recursive: true });
      await writeFile(
        join(hooksDir, 'pre-task.ts'),
        'export default () => ({ kind: "deny", message: "blocked by discovered hook" });\n',
      );

      const feature = 'use discovered hook';
      const sessionId = 'session-init-hooks';
      const config = makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { mode: 'quick', persistTranscript: false, commitStrategy: 'none' },
        approval: { enabled: false, feedRejectionsToPlanner: true },
        codebase: { enabled: false, tokenBudget: 4000, cacheDir: '.diptych' },
      });
      const { callbacks } = makeCallbacks();
      const summaryBase: SummaryBase = {
        feature,
        startTime: Date.now(),
        plannerTool: 'test-planner',
        implementerTool: 'test-implementer',
        mode: 'quick',
        projectDir,
        sessionId,
      };
      const metadata: SpecMetadata = {
        plannerTool: 'test-planner',
        implementerTool: 'test-implementer',
        mode: 'quick',
      };
      let trackedState: WorkflowState | undefined;

      const init = await initializeWorkflow({
        opts: {
          feature,
          projectDir,
          config,
          callbacks,
          sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
          _planner: makePlanner(),
          _implementer: makeImplementer(),
          allowHooks: true,
        },
        sessionId,
        summaryBase,
        metadata,
        setTrackedState: (state) => {
          trackedState = state;
        },
        resumeHolder: { messages: [] },
      });

      expect(init.ok).toBe(true);
      expect(trackedState?.feature).toBe(feature);
      if (!init.ok) return;

      const task = makeTask();
      const preTaskPayload: EngineEvent = {
        type: 'task_started',
        ts: 1,
        phase: 'implementing',
        taskId: task.id,
        title: task.title,
        index: 0,
        total: 1,
        file: task.file,
        action: task.action,
      };
      const result = await runPreHooks(init.wctx.config.hooks, 'pre_task', preTaskPayload, {
        projectDir,
        sessionId,
      });

      expect(result).toEqual({
        allow: false,
        reason: 'blocked by discovered hook',
        warnings: [],
      });
    });
  });
});
