import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, makePlanner, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { consultCallAnswering, guidanceConsult } from '#testing/helpers/typed-planner.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { loadState } from '../../../core/state/persistence.js';
import { createImplementerBase } from '../../implementers/pipeline/run.js';
import { createChangeDetector } from '../../change-detection.js';
import { enqueueUserMessage } from '../queue/submit.js';
import { runTaskLoop } from './loop.js';

let dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('a guided retry that carries a queued correction', { timeout: 90_000 }, () => {
  it('does not tell the implementer its attempt was discarded when the attempt files stay', async () => {
    const ref = setupGitSessionProject({
      prefix: 'loop-consult-correction',
      sessionId: 'sess-consult-correction',
    });
    dirs.push(ref.projectDir);
    let green = false;
    vi.spyOn(commandRunner, 'runCommand').mockImplementation(async () => {
      if (green) return { stdout: '', stderr: '', code: 0 };
      throw processError.exitCode({ command: 'tsc', code: 2, stderr: 'not finished', output: '' });
    });
    const { bus } = makeBusRecorder();
    const calls: { prompt: string; fileStayed: boolean }[] = [];
    const wctx = makeWctx({
      ...ref,
      bus,
      config: makeNoValidationConfig({ workflow: { isolation: 'none', review: 'task' } }),
      planner: makePlanner({
        typedCall: consultCallAnswering(() => {
          const current = loadState(ref);
          if (current === null) throw new Error('Missing state during the consult');
          enqueueUserMessage({
            ...ref,
            state: current,
            message: plainUserMessage('Keep the exported name.'),
            phase: current.phase,
            bus,
          });
          green = true;
          return guidanceConsult();
        }),
      }),
      implementer: createImplementerBase({
        extractsCode: false,
        detectChanges: createChangeDetector('Tool implementer (test)'),
        invoke: async ({ projectDir: runDir, prompt }) => {
          calls.push({ prompt, fileStayed: existsSync(join(runDir, 'src/a.ts')) });
          mkdirSync(join(runDir, 'src'), { recursive: true });
          writeFileSync(join(runDir, 'src/a.ts'), `export const a = ${calls.length};\n`);
          return makeRunnerCallResult({ status: 'completed', text: 'wrote src/a.ts' });
        },
      }),
    });
    const task = makeTask({
      id: 'T001',
      title: 'Add the alias',
      suggestedFiles: ['src/a.ts'],
      criteria: [],
      checks: [{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit' }],
    });

    const result = await runTaskLoop({
      wctx,
      initialState: makeImplState([task]),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('complete');
    expect(calls).toHaveLength(2);
    const retry = calls[1];
    expect(retry?.fileStayed).toBe(true);
    expect(retry?.prompt).toContain('Keep the exported name.');
    expect(retry?.prompt).not.toContain('discarded');
  });

  it('does not tell a later guided retry of the brief that its attempt was discarded', async () => {
    const ref = setupGitSessionProject({
      prefix: 'loop-consult-correction-later',
      sessionId: 'sess-consult-correction-later',
    });
    dirs.push(ref.projectDir);
    const calls: { prompt: string; fileStayed: boolean }[] = [];
    vi.spyOn(commandRunner, 'runCommand').mockImplementation(async () => {
      if (calls.length >= 3) return { stdout: '', stderr: '', code: 0 };
      throw processError.exitCode({ command: 'tsc', code: 2, stderr: 'not finished', output: '' });
    });
    const { bus } = makeBusRecorder();
    let consults = 0;
    const wctx = makeWctx({
      ...ref,
      bus,
      config: makeNoValidationConfig({ workflow: { isolation: 'none', review: 'task' } }),
      planner: makePlanner({
        typedCall: consultCallAnswering(() => {
          consults += 1;
          const current = loadState(ref);
          if (current === null) throw new Error('Missing state during the consult');
          if (consults === 1) {
            enqueueUserMessage({
              ...ref,
              state: current,
              message: plainUserMessage('Keep the exported name.'),
              phase: current.phase,
              bus,
            });
          }
          return guidanceConsult();
        }),
      }),
      implementer: createImplementerBase({
        extractsCode: false,
        detectChanges: createChangeDetector('Tool implementer (test)'),
        invoke: async ({ projectDir: runDir, prompt }) => {
          calls.push({ prompt, fileStayed: existsSync(join(runDir, 'src/a.ts')) });
          mkdirSync(join(runDir, 'src'), { recursive: true });
          writeFileSync(join(runDir, 'src/a.ts'), `export const a = ${calls.length};\n`);
          return makeRunnerCallResult({ status: 'completed', text: 'wrote src/a.ts' });
        },
      }),
    });
    const task = makeTask({
      id: 'T001',
      title: 'Add the alias',
      suggestedFiles: ['src/a.ts'],
      criteria: [],
      checks: [{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit' }],
    });

    const result = await runTaskLoop({
      wctx,
      initialState: makeImplState([task]),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('complete');
    expect(calls).toHaveLength(3);
    const later = calls[2];
    expect(later?.fileStayed).toBe(true);
    expect(later?.prompt).toContain('Keep the exported name.');
    expect(later?.prompt).not.toContain('discarded');
  });

  it('tells a guided retry that its attempt was discarded when the failed call took the files back', async () => {
    const ref = setupGitSessionProject({
      prefix: 'loop-consult-correction-discarded',
      sessionId: 'sess-consult-correction-discarded',
    });
    dirs.push(ref.projectDir);
    vi.spyOn(commandRunner, 'runCommand').mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    const { bus } = makeBusRecorder();
    const calls: { prompt: string; fileStayed: boolean }[] = [];
    const wctx = makeWctx({
      ...ref,
      bus,
      config: makeNoValidationConfig({ workflow: { isolation: 'none', review: 'task' } }),
      planner: makePlanner({
        typedCall: consultCallAnswering(() => {
          const current = loadState(ref);
          if (current === null) throw new Error('Missing state during the consult');
          enqueueUserMessage({
            ...ref,
            state: current,
            message: plainUserMessage('Keep the exported name.'),
            phase: current.phase,
            bus,
          });
          return guidanceConsult();
        }),
      }),
      implementer: createImplementerBase({
        extractsCode: false,
        detectChanges: createChangeDetector('Tool implementer (test)'),
        invoke: async ({ projectDir: runDir, prompt }) => {
          calls.push({ prompt, fileStayed: existsSync(join(runDir, 'src/a.ts')) });
          mkdirSync(join(runDir, 'src'), { recursive: true });
          writeFileSync(join(runDir, 'src/a.ts'), `export const a = ${calls.length};\n`);
          if (calls.length > 1) {
            return makeRunnerCallResult({ status: 'completed', text: 'wrote src/a.ts' });
          }
          return makeRunnerCallResult({
            status: 'failed',
            text: 'stopped half way',
            error: { code: 'turn-failed', message: 'The tool stopped half way.' },
          });
        },
      }),
    });
    const task = makeTask({
      id: 'T001',
      title: 'Add the alias',
      suggestedFiles: ['src/a.ts'],
      criteria: [],
      checks: [{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit' }],
    });

    const result = await runTaskLoop({
      wctx,
      initialState: makeImplState([task]),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('complete');
    expect(calls).toHaveLength(2);
    const retry = calls[1];
    expect(retry?.fileStayed).toBe(false);
    expect(retry?.prompt).toContain(
      '[Continuation] Your previous attempt was discarded; its error is above. The user says:',
    );
    expect(retry?.prompt).toContain('Keep the exported name.');
  });
});
