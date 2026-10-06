import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import {
  guidanceConsult,
  planFromTasks,
  typedCallPlanAndConsult,
} from '#testing/helpers/typed-planner.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function assertUnborn(dir: string) {
  expect(existsSync(join(dir, '.git/index'))).toBe(false);
  expect(existsSync(join(dir, '.git/worktrees'))).toBe(false);
  expect(readdirSync(join(dir, '.git/refs/heads'))).toEqual([]);
  expect(readdirSync(join(dir, '.git/objects')).sort()).toEqual(['info', 'pack']);
  expect(readdirSync(join(dir, '.git/objects/pack'))).toEqual([]);
}
it.each(['initial', 'local', 'consult'] as const)(
  'repeated workflow resume preserves %s output and the stopped attempt',
  async (route) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'validator-cold-workflow-'));
    roots.push(projectDir);
    execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
    const sessionId = 'parked-workflow';
    const feature = 'Build partial module';
    const task = makeTask({
      suggestedFiles: ['partial.ts'],
      scope: { inBounds: ['partial.ts'], outOfBounds: ['other files'] },
      evidence: ['The module exports complete'],
      typeDefs: 'export const complete: boolean',
    });
    const config = makeNoValidationConfig({
      workflow: { approve: 'none', maxRetries: 1 },
      approval: { feedRejectionsToPlanner: false },
    });
    const ref = { projectDir, sessionId };
    const expectedAttempt = route === 'consult' ? 2 : route === 'initial' ? 0 : 1;
    let saved: WorkflowState | undefined;
    const observed: Array<{
      attempt: number;
      workspace: string;
      previous: string | null;
      fallback: boolean;
      continuation: ImplementerOptions['continuation'];
      gitAbsent: boolean;
    }> = [];
    for (let entry = 0; entry < 3; entry++) {
      const stop = new AbortController();
      const bus = createEventBus();
      let fallback = false;
      bus.subscribe((event) => {
        if (
          event.type === 'warning' &&
          (event.message.includes('repository has no commits') ||
            event.message.includes('resuming retained staged-copy workspace'))
        )
          fallback = true;
      });
      const planner = makePlanner({
        typedCall: typedCallPlanAndConsult(
          () => planFromTasks([task]),
          () => guidanceConsult('Try the other marker.'),
        ),
      });
      const writeAndStop = async (opts: ImplementerOptions) => {
        roots.push(dirname(opts.projectDir));
        const path = join(opts.projectDir, 'partial.ts');
        const previous = existsSync(path) ? readFileSync(path, 'utf8') : null;
        observed.push({
          attempt: loadState(ref)?.attempt ?? -1,
          workspace: opts.projectDir,
          previous,
          fallback,
          continuation: opts.continuation,
          gitAbsent: !existsSync(join(opts.projectDir, '.git')),
        });
        writeFileSync(path, `${previous ?? ''}entry-${entry}\n`);
        stop.abort();
        return { success: false, output: '', outcome: 'user-abort' as const };
      };
      await runWorkflow({
        prepared: makePreparedExecution({
          ...ref,
          feature,
          config,
          ...(saved === undefined ? {} : { resumeState: saved }),
        }),
        ...(saved === undefined ? {} : { savedState: saved }),
        callbacks: makeCallbacks().callbacks,
        sinks: TEST_SINKS,
        signal: stop.signal,
        eventBus: bus,
        _planner: planner,
        _implementer: makeImplementer({
          capabilities: { writesFiles: 'direct' },
          implement: async (opts) =>
            entry === 0 && route !== 'initial'
              ? { success: false, output: '', error: `${route} initial failure` }
              : writeAndStop(opts),
          retry: async (opts) =>
            route === 'consult' && opts.kind === 'local'
              ? { success: false, output: '', error: 'the local retry needs the planner' }
              : writeAndStop(opts),
        }),
      });
      assertUnborn(projectDir);
      const state = loadState(ref);
      if (state === null) throw new Error('missing saved workflow');
      expect(state).toMatchObject({
        phase: 'implementing',
        attempt: expectedAttempt,
        awaitingContinue: true,
        interruptedStep: {
          cut: 'mid-step',
          step: { kind: 'brief', taskId: task.id, attempt: expectedAttempt },
        },
        tasks: [{ status: 'in_progress' }],
      });
      expect(state.pendingRecovery).toBeUndefined();
      expect(existsSync(join(projectDir, 'partial.ts'))).toBe(false);
      saved = state;
    }
    console.log(JSON.stringify({ case: 'three-full-workflow-entries', observed }));
    expect(observed).toHaveLength(3);
    expect.soft(observed[1]?.previous).toBe('entry-0\n');
    expect.soft(observed[2]?.previous).toBe('entry-0\nentry-1\n');
    for (const entry of observed) {
      expect(entry.attempt).toBe(expectedAttempt);
      expect(entry).toMatchObject({ fallback: true, gitAbsent: true });
    }
    for (const entry of observed.slice(1)) {
      expect(entry.continuation?.partial).toBe('');
      expect(entry.continuation?.extra).toContain('partial.ts');
    }
  },
  30_000,
);
