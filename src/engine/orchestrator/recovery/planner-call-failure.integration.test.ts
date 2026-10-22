import { realpathSync, statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { installClaudeShim } from '#testing/helpers/claude-cli-shim.js';
import { invokeTestClaude } from '#testing/helpers/claude-planner-steer-test-invoke.js';
import { prependPath } from '#testing/helpers/command-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createAgentPlanner } from '../../planners/agent.js';
import { createShellPlanner } from '../../planners/shell.js';
import { requestTyped } from '../../runners/typed-output.js';
import { seatFailureFromError, seatResetWaitDeadline } from '../escalation/seat-wait.js';
import { diagnosePlannerCallFailure } from './planner-call-failure.js';

const LIMIT_LINE = "Error: You've hit your usage limit. Your limit resets at 3pm.";

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('planner-call-failure-stdout');
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

/** A `shell` or `agent` planner-tier seat whose script prints these stdout lines and exits 1. */
function seatConfig(kind: 'shell' | 'agent', stdout: readonly string[]) {
  const script = [
    'cat >/dev/null',
    ...stdout.map((line) => `echo ${JSON.stringify(line)}`),
    'exit 1',
  ];
  return makeConfig({ planner: { kind, command: 'bash', args: ['-c', script.join('; ')] } });
}

async function failedCall(
  kind: 'shell' | 'agent',
  seat: 'planner' | 'reviewer',
  stdout: readonly string[],
) {
  const config = seatConfig(kind, stdout);
  const planner = kind === 'shell' ? createShellPlanner(config) : createAgentPlanner(config);
  const err = await requestTyped({
    prompt: 'q',
    schema: z.object({ answer: z.string() }),
    jsonSchema: { type: 'object' },
    schemaName: 'probe',
    call: planner.typedCall({ projectDir, callbacks: { onOutput: vi.fn() }, seat }),
  }).then(
    () => {
      throw new Error('the seat call resolved');
    },
    (thrown: unknown) => thrown,
  );
  return { err, runner: config.planner };
}

describe('diagnosePlannerCallFailure — a limit a seat prints only on stdout', () => {
  it.each([
    ['shell', 'planner', 'plan', 'Planning failed'],
    ['agent', 'reviewer', 'review', 'Review failed'],
  ] as const)(
    'the %s %s seat halts on its usage limit with the reset',
    async (kind, seat, swap, label) => {
      const { err, runner } = await failedCall(kind, seat, ['working…', LIMIT_LINE]);

      const diagnosis = diagnosePlannerCallFailure({ err, label, runner, seat: swap });

      expect(diagnosis.failure).toBe('usage-limit');
      expect(diagnosis.words).toBe(LIMIT_LINE);
      expect([diagnosis.resetsAt?.getHours(), diagnosis.resetsAt?.getMinutes()]).toEqual([15, 0]);
    },
  );

  it.each([
    ['a limit phrase above an ordinary last line', [LIMIT_LINE, 'done']],
    ['a last line of prose that names a limit', ['The file is within the size limit']],
  ])('keeps an ordinary failed call on %s', async (_, stdout) => {
    const { err, runner } = await failedCall('shell', 'planner', stdout);

    const diagnosis = diagnosePlannerCallFailure({
      err,
      label: 'Planning failed',
      runner,
      seat: 'plan',
    });

    expect(diagnosis.failure).toBe('call-failed');
    expect(diagnosis.message).toBe('Planning failed: bash exited with code 1');
  });
});

describe('diagnosePlannerCallFailure — a failed call whose model last named a limit', () => {
  it('keeps a claude-code planner stream that ends without a result as a failed call', async () => {
    const shimDir = createTempDir('planner-call-failure-claude');
    const restorePath = prependPath(shimDir);
    try {
      const prose =
        'The new handler returns HTTP 429 Too Many Requests once the usage limit is hit.';
      installClaudeShim(shimDir, [
        '{"type":"system","session_id":"s1"}',
        JSON.stringify({
          type: 'assistant',
          message: { id: 'm1', content: [{ type: 'text', text: prose }] },
        }),
      ]);
      const path = realpathSync(`${shimDir}/claude`);
      const { dev, ino, size, mtimeMs } = statSync(path);
      const err = await invokeTestClaude({
        prompt: 'p',
        projectDir,
        onOutput: vi.fn(),
        executable: { path, fingerprint: { dev, ino, size, mtimeMs } },
      }).then(
        () => {
          throw new Error('the seat call resolved');
        },
        (thrown: unknown) => thrown,
      );
      const runner = makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
      }).planner;

      const diagnosis = diagnosePlannerCallFailure({
        err,
        label: 'Planning failed',
        runner,
        seat: 'plan',
      });

      expect(err).toMatchObject({ kind: 'runner-call-failed', data: { output: prose } });
      expect(diagnosis.failure).toBe('call-failed');
      expect(diagnosis.seatDown).toBeUndefined();
    } finally {
      restorePath();
      cleanupTempDir(shimDir);
    }
  });
});

describe('seatFailureFromError — a consult whose seat prints its limit only on stdout', () => {
  it('waits for the reset the stdout line names', async () => {
    const { err } = await failedCall('shell', 'planner', [LIMIT_LINE]);
    const now = new Date(2026, 9, 22, 14, 55);

    const deadline = seatResetWaitDeadline(seatFailureFromError(err), now);

    expect(deadline).toEqual(new Date(2026, 9, 22, 15, 0));
  });
});
