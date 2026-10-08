import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { createValidator } from '../validation/run.js';
import type { ValidationCommandRunner } from '../validation/types.js';
import { runTaskLoop } from './loop.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe("runTaskLoop with workflow.review 'end'", { timeout: 120_000 }, () => {
  it('runs no gate command at all: none before the first brief, after a brief or between batches', async () => {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'gate-cadence-end',
      sessionId: 'sess-gate-end',
    });
    dirs.push(projectDir);
    const commands: string[] = [];
    const runCommand: ValidationCommandRunner = async (cmd, args) => {
      commands.push([cmd, ...args].join(' '));
      return { stdout: '', stderr: '', code: 0 };
    };
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (call: ImplementerOptions) => {
        const file = call.task.suggestedFiles[0] ?? 'src/missing.ts';
        mkdirSync(join(call.projectDir, dirname(file)), { recursive: true });
        writeFileSync(join(call.projectDir, file), 'export const value = 1;\n');
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeConfig({
          validation: {
            typecheck: true,
            lint: true,
            test: true,
            typecheckCommand: 'npx tsc --noEmit',
            lintCommand: 'npx biome check .',
            testCommand: 'npm test',
          },
          workflow: {},
        }),
        callbacks: makeCallbacks().callbacks,
        implementer,
        bus,
        validator: createValidator({ runCommand }),
      }),
      initialState: makeImplState([
        makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], batch: 1 }),
        makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], batch: 2 }),
      ]),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('complete');
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'done']);
    // At review: end the gates run once, at the final review: the task loop runs none.
    expect(commands).toEqual([]);
    expect(events.filter((event) => event.type === 'validate')).toEqual([]);
    expect(events.filter((event) => event.type === 'full_suite')).toEqual([]);
  });
});
