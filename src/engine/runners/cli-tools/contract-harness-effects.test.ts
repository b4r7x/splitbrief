import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliExecutableReceipt } from '../../../core/discovery/detection.js';
import { effectScenario, runEffect } from '#testing/helpers/factories/cli-effect-fixture.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { CLI_CONFORMANCE_EXIT_CODES } from './contract-harness.js';
import { runFactoryEffectConformance } from './contract-harness-effects.js';

const NONCE = 'nonce-7f3a9c11';

describe('production-factory effect conformance', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes a non-mutating planner through the production factory and records the proof', async () => {
    const scenario = await effectScenario('planner-immutable');
    try {
      const outcome = await runEffect({
        role: 'planner',
        body: 'exit 0',
        effect: { kind: 'planner-read-only' },
        ...scenario,
      });
      expect(outcome).toEqual({
        exitCode: CLI_CONFORMANCE_EXIT_CODES.PASS,
        verdict: 'PASS',
        candidateId: 'opencode',
        role: 'planner',
      });
      const record = JSON.parse(await readFile(scenario.recordPath, 'utf8')) as {
        verdict: string;
        changedFiles: string[];
      };
      expect(record.verdict).toBe('PASS');
      expect(record.changedFiles).toEqual([]);
      expect((await stat(scenario.recordPath)).mode & 0o777).toBe(0o600);
    } finally {
      await scenario.cleanup();
    }
  });

  it('rejects a planner that mutates the staged project', async () => {
    const scenario = await effectScenario('planner-mutating');
    try {
      const outcome = await runEffect({
        role: 'planner',
        body: `mkdir -p src\nprintf '%s' 'mutated' > src/hello.ts\nexit 0`,
        effect: { kind: 'planner-read-only' },
        ...scenario,
      });
      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.OMIT);
      expect(outcome.verdict).toBe('OMIT');
      expect(outcome.reason).toMatch(/mutated the staged project.*src\/hello\.ts/);
      const record = JSON.parse(await readFile(scenario.recordPath, 'utf8')) as {
        changedFiles: string[];
      };
      expect(record.changedFiles).toContain('src/hello.ts');
    } finally {
      await scenario.cleanup();
    }
  });

  it('rejects a planner that times out, with no staged change', async () => {
    const scenario = await effectScenario('planner-timeout');
    try {
      const outcome = await runEffect({
        role: 'planner',
        body: 'while :; do sleep 1; done',
        effect: { kind: 'planner-read-only' },
        timeoutMs: 1_200,
        ...scenario,
      });
      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.OMIT);
      expect(outcome.reason).toMatch(/timeout/i);
    } finally {
      await scenario.cleanup();
    }
  });

  it('passes an implementer that makes exactly the nonce-bearing change at the declared path', async () => {
    const scenario = await effectScenario('implementer-exact');
    try {
      const outcome = await runEffect({
        role: 'implementer',
        body: `mkdir -p src\nprintf '%s' '${NONCE}' > src/hello.ts\nexit 0`,
        effect: { kind: 'direct-write', file: 'src/hello.ts', nonceContent: NONCE },
        task: makeTask(),
        ...scenario,
      });
      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      expect(outcome.verdict).toBe('PASS');
      expect(outcome.role).toBe('implementer');
      expect(await readFile(join(scenario.projectDir, 'src', 'hello.ts'), 'utf8')).toBe(NONCE);
    } finally {
      await scenario.cleanup();
    }
  });

  it('rejects a no-op implementer', async () => {
    const scenario = await effectScenario('implementer-noop');
    try {
      const outcome = await runEffect({
        role: 'implementer',
        body: 'exit 0',
        effect: { kind: 'direct-write', file: 'src/hello.ts', nonceContent: NONCE },
        task: makeTask(),
        ...scenario,
      });
      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.OMIT);
      expect(outcome.reason).toMatch(/without changing any files|no staged-project change/i);
    } finally {
      await scenario.cleanup();
    }
  });

  it('rejects an implementer that writes an unrelated target', async () => {
    const scenario = await effectScenario('implementer-wrong-target');
    try {
      const outcome = await runEffect({
        role: 'implementer',
        body: `printf '%s' '${NONCE}' > unrelated.txt\nexit 0`,
        effect: { kind: 'direct-write', file: 'src/hello.ts', nonceContent: NONCE },
        task: makeTask(),
        ...scenario,
      });
      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.OMIT);
      expect(outcome.reason).toMatch(/instead of exactly src\/hello\.ts/);
    } finally {
      await scenario.cleanup();
    }
  });

  it('rejects an implementer that writes the declared path with different content', async () => {
    const scenario = await effectScenario('implementer-wrong-content');
    try {
      const outcome = await runEffect({
        role: 'implementer',
        body: `mkdir -p src\nprintf '%s' 'wrong-content' > src/hello.ts\nexit 0`,
        effect: { kind: 'direct-write', file: 'src/hello.ts', nonceContent: NONCE },
        task: makeTask(),
        ...scenario,
      });
      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.OMIT);
      expect(outcome.reason).toMatch(/does not match the declared nonce/);
    } finally {
      await scenario.cleanup();
    }
  });

  it('rejects an implementer whose exact change is accompanied by an extra mutation', async () => {
    const scenario = await effectScenario('implementer-extra');
    try {
      const outcome = await runEffect({
        role: 'implementer',
        body: `mkdir -p src\nprintf '%s' '${NONCE}' > src/hello.ts\nprintf '%s' 'extra' > extra.txt\nexit 0`,
        effect: { kind: 'direct-write', file: 'src/hello.ts', nonceContent: NONCE },
        task: makeTask(),
        ...scenario,
      });
      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.OMIT);
      expect(outcome.reason).toMatch(/extra\.txt.*instead of exactly src\/hello\.ts/);
    } finally {
      await scenario.cleanup();
    }
  });

  it('rejects an implementer that falls back to a read-only posture writing only disposable paths', async () => {
    const scenario = await effectScenario('implementer-fallback-role');
    try {
      const outcome = await runEffect({
        role: 'implementer',
        body: `printf '%s' 'read-only fallback' > "$HOME/disposable.txt"\nexit 0`,
        effect: { kind: 'direct-write', file: 'src/hello.ts', nonceContent: NONCE },
        task: makeTask(),
        ...scenario,
      });
      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.OMIT);
      expect(outcome.reason).toMatch(/without changing any files|no staged-project change/i);
    } finally {
      await scenario.cleanup();
    }
  });

  it.each([
    ['failure', 'exit 1', /exit(ed with code)? 1/i],
    ['timeout', 'while :; do sleep 1; done', /timed out|timeout/i],
    ['crash', 'kill -9 $$', /signal SIGKILL|signal-exit/i],
  ] as const)(
    'classifies the %s implementer terminal outcome as an effect rejection',
    async (_label, body, reasonPattern) => {
      const scenario = await effectScenario('implementer-outcome');
      try {
        const outcome = await runEffect({
          role: 'implementer',
          body,
          effect: { kind: 'direct-write', file: 'src/hello.ts', nonceContent: NONCE },
          task: makeTask(),
          timeoutMs: 1_500,
          ...scenario,
        });
        expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.OMIT);
        expect(outcome.reason).toMatch(reasonPattern);
      } finally {
        await scenario.cleanup();
      }
    },
    30_000,
  );

  it('reaps a timed-out implementer process group and rejects the outcome', async () => {
    const scenario = await effectScenario('implementer-reap');
    try {
      const pidFile = join(scenario.toolsDir, 'child.pid');
      const outcome = await runEffect({
        role: 'implementer',
        body: `printf '%s\\n' "$$" > ${JSON.stringify(pidFile)}\nwhile :; do sleep 1; done`,
        effect: { kind: 'direct-write', file: 'src/hello.ts', nonceContent: NONCE },
        task: makeTask(),
        timeoutMs: 1_200,
        ...scenario,
      });
      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.OMIT);
      const childPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
      expect(childPid).toBeGreaterThan(1);
      expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    } finally {
      await scenario.cleanup();
    }
  }, 30_000);

  it('rejects an aborted implementer call without leaking the child', async () => {
    const scenario = await effectScenario('implementer-abort');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 600);
      try {
        const outcome = await runEffect({
          role: 'implementer',
          body: 'while :; do sleep 1; done',
          effect: { kind: 'direct-write', file: 'src/hello.ts', nonceContent: NONCE },
          task: makeTask(),
          timeoutMs: 15_000,
          signal: controller.signal,
          ...scenario,
        });
        expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.OMIT);
        expect(outcome.reason).toMatch(/abort/i);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await scenario.cleanup();
    }
  }, 30_000);

  it('records an OMIT when the executable receipt is invalid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-invalid-receipt-'));
    try {
      const recordPath = join(directory, 'evidence.json');
      const outcome = await runFactoryEffectConformance({
        role: 'planner',
        projectDir: directory,
        prompt: 'review the staged plan',
        executable: {} as unknown as CliExecutableReceipt,
        effect: { kind: 'planner-read-only' },
        recordPath,
      });
      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.OMIT);
      expect(outcome.reason).toBe('invalid executable receipt');
      const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
      expect(record).toMatchObject({ verdict: 'OMIT', changedFiles: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
