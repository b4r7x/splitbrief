import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import {
  fakeDeps,
  getStartCommandTmp,
  setupStartCommandIntegration,
  writeReadyReadinessFixtures,
} from '#testing/helpers/start-command.js';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  preparedHeadlessExecution,
  writeMinimalHeadlessConfigYaml,
} from '#testing/helpers/headless-project.js';
import { registerStartCommand } from '../../../src/cli/commands/start/register.js';
import type { StartDeps } from '../../../src/cli/commands/start/types.js';
import { runHeadless } from '../../../src/cli/headless.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { writeActive } from '../../../src/core/sessions/active-pointer.js';
import { buildRetryExhaustedRecoveryIssue } from '../../../src/engine/orchestrator/recovery/builders/task.js';

const TARGET_FILE = 'src/loop.ts';

/** The four line shapes `createStdoutTextSink` writes, and nothing else. */
const PLAIN_LINE = /^(?:phase|review|done): \S|^task \S+: (?:done|failed) \(/;

function isNdjsonRecord(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

setupStartCommandIntegration();

describe('splitbrief start --plain', { timeout: 90_000 }, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the run as plain lines and puts no NDJSON record on the same stdout', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp, { validation: false, codebase: false });

    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: TARGET_FILE,
      title: 'Plain output backed module',
      description: 'Create a module so the plain sink has a task to report.',
      implementationSteps: ['Create src/loop.ts with the marker export.'],
      tests: ['the plain sink writes task T001: done'],
      scope: { inBounds: [TARGET_FILE], outOfBounds: ['unrelated files'] },
      evidence: ['the plain sink writes task T001: done'],
      typeDefs: 'export const loop: string',
    });

    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec\n\nCreate a module.',
        plan: '# Plan\n\nUse the configured implementer.',
        tasks: [task],
        usage: { inputTokens: 140, outputTokens: 90 },
      }),
      review: vi.fn().mockResolvedValue({
        text: '# Final review\n\nPassed validation.',
        usage: { inputTokens: 60, outputTokens: 30 },
      }),
    });

    // The implementer writes into the dir the orchestrator hands it, which is
    // the staged copy when isolation is on.
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        const target = join(opts.projectDir, TARGET_FILE);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, 'export const loop = "plain";\n', 'utf-8');
        return { success: true, output: 'code', usage: { inputTokens: 100, outputTokens: 50 } };
      }),
    });

    // The seats are injected rather than spawned: this test is about which
    // stdout rendering `--plain` installs, and a real subprocess would add an
    // auth-channel gate that has nothing to do with that contract.
    const realHeadlessDeps: StartDeps = {
      ...fakeDeps,
      runHeadless: (options) =>
        runHeadless({ ...options, _planner: planner, _implementer: implementer }),
    };

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, realHeadlessDeps);
    await program.parseAsync([
      'node',
      'splitbrief',
      'start',
      '--plain',
      '--mode',
      'standard',
      '--approve',
      'none',
      'run a plain-output loop',
      '--project',
      tmp,
    ]);

    const stdout = chunks.join('');
    expect(stdout).toContain('phase: researching');
    expect(stdout).toContain('task T001: done');

    const lines = stdout.trimEnd().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(PLAIN_LINE);
      // The guarantee under test: `--plain` and `--json` never share a stream,
      // so not one line here is a public NDJSON record — not the
      // `readiness_report` the JSON rendering opens with, and not a terminal
      // `error` / `recovery_required` record either.
      expect(isNdjsonRecord(line)).toBe(false);
    }
  });

  it('keeps the terminal recovery record off a plain stdout while still failing the run', async () => {
    const tmp = getStartCommandTmp();
    writeMinimalHeadlessConfigYaml(tmp);
    const sessionId = 'sess-plain-recovery';
    ensureSessionDir(tmp, sessionId);
    writeActive({ projectDir: tmp, sessionId });

    const task = makeTask({ id: 'T001' });
    const state = transition(
      {
        ...createInitialState('recover me'),
        phase: 'implementing',
        tasks: [task],
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      {
        type: 'SET_PENDING_RECOVERY',
        issue: buildRetryExhaustedRecoveryIssue({
          task,
          validationSummary: 'npm test failed',
          attempts: 2,
          maxAttempts: 2,
          createdAt: '2026-04-29T00:00:00.000Z',
        }),
      },
    );
    saveState({ projectDir: tmp, sessionId }, state);

    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // The JSON rendering answers this halt with a `recovery_required` record on
    // stdout. Under `--plain` the same halt must reach the operator only
    // through the thrown error's stderr message, or the two renderings would
    // share one stream after all.
    await expect(
      runHeadless({
        prepared: preparedHeadlessExecution({
          projectDir: tmp,
          sessionId,
          feature: 'recover me',
          resumeState: state,
        }),
        plain: true,
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('Recovery required'),
    });

    const stdout = chunks.join('');
    expect(stdout).not.toContain('recovery_required');
    for (const line of stdout.trimEnd().split('\n').filter(Boolean)) {
      expect(isNdjsonRecord(line)).toBe(false);
    }
  });
});
