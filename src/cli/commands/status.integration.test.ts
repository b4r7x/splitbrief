import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import chalk from 'chalk';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { registerStatusCommand } from './status.js';
import { SPLITBRIEF_DIR, STATE_FILE, SESSION_LOG_FILE, SEATS_FILE } from '../../core/paths.js';
import { createInitialState } from '../../core/state/machine.js';
import {
  recordSeatIdentities,
  reconcileSeatIdentities,
  seatIdentitiesFromConfig,
} from '../../core/state/seats.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { plainTheme, resolveTheme } from '../../core/theme/resolve.js';
import { paint } from '../../core/theme/paint.js';

const buildSwitch = {
  seat: 'build',
  from: 'Claude Code CLI · Sonnet 5.5 · high',
  to: 'Claude Code CLI · Sonnet 5.5 · max',
  toSeat: { tool: 'claude-code', model: 'sonnet', effort: 'max' },
  cause: 'runner-usage-limit',
  auto: false,
  configRevision: 'switched',
  ts: '2026-10-13T10:01:00.000Z',
} as const;

let tmp: string;
// console.log is a sanctioned global spy — see docs/TESTING.md core rules.
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = createTempDir('status-command-test');
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  consoleSpy.mockRestore();
});

function captureOutput(): string {
  return consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
}

function writeActiveSession(
  projectDir: string,
  sessionId: string,
  feature: string,
  overrides: Partial<WorkflowState> = {},
): void {
  const sessionDir = join(projectDir, SPLITBRIEF_DIR, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const state = { ...createInitialState(feature), phase: 'implementing' as const, ...overrides };
  writeFileSync(join(sessionDir, STATE_FILE), JSON.stringify(state));
  writeFileSync(join(sessionDir, SESSION_LOG_FILE), '');
  mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(join(projectDir, SPLITBRIEF_DIR, 'active'), sessionId + '\n');
}

function writeRunnerCalls(
  sessionId: string,
  calls: readonly {
    callId: string;
    role: 'planner' | 'implementer';
    backendKind: 'api' | 'cli';
    runnerName: string;
  }[],
): void {
  const lines = calls.map((call, index) =>
    JSON.stringify({
      ts: `2026-09-27T10:00:0${index}.000Z`,
      kind: 'event',
      type: 'runner_call_started',
      phase: 'implementing',
      data: { ...call, attempt: 1, sequence: index + 1 },
    }),
  );
  writeFileSync(
    join(tmp, SPLITBRIEF_DIR, 'sessions', sessionId, SESSION_LOG_FILE),
    `${lines.join('\n')}\n`,
  );
}

async function runStatus(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStatusCommand(program);
  await program.parseAsync(['node', 'splitbrief', 'status', '--project', tmp, ...args]);
}

describe('status command', () => {
  describe('theme colours', () => {
    let originalLevel: typeof chalk.level;

    beforeEach(() => {
      originalLevel = chalk.level;
      chalk.level = 3;
    });

    afterEach(() => {
      chalk.level = originalLevel;
      vi.unstubAllEnvs();
    });

    it('uses light truecolor colours when COLORFGBG decides the background', async () => {
      writeActiveSession(tmp, '2026-10-08-theme', 'theme output');
      vi.stubEnv('COLORFGBG', '0;15');

      await runStatus([]);

      expect(captureOutput()).toContain(paint(plainTheme().textDim, 'Feature:'));
      expect(plainTheme().textDim).toBe(
        resolveTheme({ variant: 'light', level: 3, terminalBackground: undefined }).textDim,
      );
      expect(stripVTControlCharacters(captureOutput())).toContain('theme output');
    });

    it('uses terminal ANSI colours when COLORFGBG is absent', async () => {
      writeActiveSession(tmp, '2026-10-08-theme', 'theme output');
      vi.stubEnv('COLORFGBG', undefined);

      await runStatus([]);

      expect(captureOutput()).toContain(paint(plainTheme().textDim, 'Feature:'));
      expect(plainTheme().textDim).toMatch(
        /^(black|red|green|yellow|blue|magenta|cyan|white|gray)(Bright)?$/,
      );
      expect(stripVTControlCharacters(captureOutput())).toContain('theme output');
    });
  });

  it('reports no active workflow when .splitbrief has no active marker', async () => {
    await runStatus([]);
    const out = captureOutput();
    expect(out).toContain('No active workflow');
  });

  it('reports the feature name and stopped status without a live process', async () => {
    writeActiveSession(tmp, '2026-04-18-add-auth', 'add auth');

    await runStatus([]);
    const out = captureOutput();
    expect(out).toContain('add auth');
    expect(out).toContain('Status:   stopped');
  });

  it('names the last brief, not one past it, once every brief has settled', async () => {
    writeActiveSession(tmp, '2026-09-21-all-settled', 'all settled', {
      phase: 'final-review',
      currentTaskIndex: 2,
      tasks: [makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002', status: 'done' })],
    });

    await runStatus([]);

    expect(stripVTControlCharacters(captureOutput())).toContain('Task:     2/2');
  });

  it('reports the repository-root session when run from a package subdirectory', async () => {
    createTestGitRepo(tmp);
    const subdir = join(tmp, 'packages', 'web');
    mkdirSync(subdir, { recursive: true });
    writeActiveSession(tmp, '2026-04-18-add-auth', 'add auth');

    const program = new Command();
    program.exitOverride();
    registerStatusCommand(program);
    await program.parseAsync(['node', 'splitbrief', 'status', '--project', subdir]);

    const out = captureOutput();
    expect(out).toContain('add auth');
    expect(out).not.toContain('No active workflow');
  });

  it('names a custom API seat by its literal provider word and pretty model even when its name is a CLI tool id', async () => {
    const sessionId = '2026-09-27-api-twin';
    writeActiveSession(tmp, sessionId, 'api twin', {
      plannerTool: 'opencode',
      plannerModel: 'gpt-5',
    });
    writeRunnerCalls(sessionId, [
      { callId: 'call-1', role: 'planner', backendKind: 'api', runnerName: 'opencode' },
    ]);

    await runStatus([]);

    const out = stripVTControlCharacters(captureOutput());
    expect(out).toContain('Planner:  opencode · GPT-5');
    expect(out).not.toContain('OpenCode CLI');
  });

  it('resolves each seat from its own recorded kind when API and CLI share a name', async () => {
    const sessionId = '2026-09-27-twin-seats';
    writeActiveSession(tmp, sessionId, 'twin seats', {
      plannerTool: 'opencode',
      plannerModel: 'gpt-5',
      implementerTool: 'opencode',
      implementerModel: 'gpt-5',
    });
    writeRunnerCalls(sessionId, [
      { callId: 'call-planner', role: 'planner', backendKind: 'api', runnerName: 'opencode' },
      {
        callId: 'call-implementer',
        role: 'implementer',
        backendKind: 'cli',
        runnerName: 'opencode',
      },
    ]);

    await runStatus([]);

    const out = stripVTControlCharacters(captureOutput());
    expect(out).toContain('Planner:  opencode · GPT-5');
    expect(out).toContain('Impl:     OpenCode CLI · GPT-5');
  });

  it('keeps a seat tool word literal and its model pretty when its own calls recorded both kinds', async () => {
    const sessionId = '2026-09-27-ambiguous-seat';
    writeActiveSession(tmp, sessionId, 'ambiguous seat', {
      plannerTool: 'opencode',
      plannerModel: 'gpt-5',
    });
    writeRunnerCalls(sessionId, [
      { callId: 'call-first', role: 'planner', backendKind: 'api', runnerName: 'opencode' },
      { callId: 'call-second', role: 'planner', backendKind: 'cli', runnerName: 'opencode' },
    ]);

    await runStatus([]);

    const out = stripVTControlCharacters(captureOutput());
    expect(out).toContain('Planner:  opencode · GPT-5');
    expect(out).not.toContain('OpenCode CLI');
  });

  it('keeps the CLI catalog name for a recorded CLI seat', async () => {
    writeActiveSession(tmp, '2026-09-27-cli-seat', 'cli seat', {
      plannerTool: 'claude-code',
      plannerModel: 'sonnet',
    });

    await runStatus([]);

    expect(stripVTControlCharacters(captureOutput())).toContain(
      'Planner:  Claude Code CLI · Sonnet 5.5',
    );
  });

  it('uses the current recorded seat kind when earlier calls used the same name for a CLI', async () => {
    const sessionId = '2026-10-13-current-api-seat';
    writeActiveSession(tmp, sessionId, 'current API seat', {
      plannerTool: 'claude-code',
      plannerModel: 'sonnet',
      plannerKind: 'api',
    });
    writeRunnerCalls(sessionId, [
      { callId: 'call-1', role: 'planner', backendKind: 'cli', runnerName: 'claude-code' },
    ]);
    recordSeatIdentities(
      { projectDir: tmp, sessionId },
      makeConfig({
        planner: {
          kind: 'api',
          provider: 'claude-code',
          model: 'sonnet',
          apiBase: 'http://127.0.0.1:11434/v1',
        },
      }),
    );

    await runStatus([]);

    const out = stripVTControlCharacters(captureOutput());
    expect(out).toContain('Planner:  claude-code · Sonnet');
    expect(out).not.toContain('Claude Code CLI');
    expect(out).not.toContain('Sonnet 5.5');
    expect(out).not.toContain('high');
  });

  it('prints the latest switched seat axes instead of the axes saved before the switch', async () => {
    const sessionId = '2026-10-13-switched-axes';
    writeActiveSession(tmp, sessionId, 'switched axes');
    recordSeatIdentities(
      { projectDir: tmp, sessionId },
      makeConfig({
        implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet', effort: 'high' },
      }),
    );
    writeActiveSession(tmp, sessionId, 'switched axes', {
      implementerTool: 'claude-code',
      implementerModel: 'sonnet',
      implementerKind: 'cli',
      seatSwitches: [buildSwitch],
    });
    await runStatus([]);

    const out = stripVTControlCharacters(captureOutput());
    expect(out).toContain('Impl:     Claude Code CLI · Sonnet 5.5 · max');
    expect(out).not.toContain('high');
  });

  it.each(['high', 'max'] as const)(
    'prints %s after switching to max and resuming with that setting',
    async (effort) => {
      const sessionId = '2026-10-13-resumed-identity';
      const ref = { projectDir: tmp, sessionId };
      const implementer = { kind: 'cli', tool: 'claude-code', model: 'sonnet' } as const;
      writeActiveSession(tmp, sessionId, 'resumed identity');
      recordSeatIdentities(ref, makeConfig({ implementer: { ...implementer, effort: 'high' } }));
      writeActiveSession(tmp, sessionId, 'resumed identity', {
        implementerTool: implementer.tool,
        implementerModel: implementer.model,
        implementerKind: implementer.kind,
        seatSwitches: [buildSwitch],
      });

      reconcileSeatIdentities(ref, makeConfig({ implementer: { ...implementer, effort } }));
      await runStatus([]);

      expect(stripVTControlCharacters(captureOutput()).split('\n')).toContain(
        `Impl:     Claude Code CLI · Sonnet 5.5 · ${effort}`,
      );
    },
  );

  it.each([
    { record: 'ids', structured: true, expected: ' · max' },
    { record: 'labels', structured: true, expected: ' · max' },
    { record: 'none', structured: true, expected: ' · max' },
    { record: 'ids', structured: false, expected: ' · high' },
    { record: 'labels', structured: false, expected: '' },
    { record: 'none', structured: false, expected: '' },
  ] as const)(
    'reads an older $record record with structured switch=$structured',
    async ({ record, structured, expected }) => {
      const sessionId = '2026-10-13-older-identity';
      writeActiveSession(tmp, sessionId, 'older identity', {
        implementerTool: 'claude-code',
        implementerModel: 'sonnet',
        implementerKind: 'cli',
        seatSwitches: [{ ...buildSwitch, toSeat: structured ? buildSwitch.toSeat : undefined }],
      });
      if (record !== 'none') {
        const seats = seatIdentitiesFromConfig(
          makeConfig({
            implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet', effort: 'high' },
          }),
        );
        writeFileSync(
          join(tmp, SPLITBRIEF_DIR, 'sessions', sessionId, SEATS_FILE),
          JSON.stringify(
            record === 'ids'
              ? seats
              : { plan: seats.plan, build: seats.build, review: seats.review },
          ),
        );
      }

      await runStatus([]);

      expect(stripVTControlCharacters(captureOutput()).split('\n')).toContain(
        `Impl:     Claude Code CLI · Sonnet 5.5${expected}`,
      );
    },
  );

  it('uses the last change of a seat and its index across all seats', async () => {
    const sessionId = '2026-10-13-switch-order';
    const ref = { projectDir: tmp, sessionId };
    const implementer = {
      kind: 'cli',
      tool: 'claude-code',
      model: 'sonnet',
      effort: 'high',
    } as const;
    const seatState = {
      implementerTool: implementer.tool,
      implementerModel: implementer.model,
      implementerKind: implementer.kind,
    };
    const planSwitch = { ...buildSwitch, seat: 'plan' } as const;
    writeActiveSession(tmp, sessionId, 'switch order', seatState);
    recordSeatIdentities(ref, makeConfig({ implementer }));
    writeActiveSession(tmp, sessionId, 'switch order', {
      ...seatState,
      seatSwitches: [buildSwitch, planSwitch],
    });
    reconcileSeatIdentities(ref, makeConfig({ implementer }));

    const latest = {
      ...buildSwitch,
      toSeat: { ...buildSwitch.toSeat, effort: 'low' },
      ts: '2026-10-13T10:00:00.000Z',
    } as const;
    for (const structured of [true, false]) {
      writeActiveSession(tmp, sessionId, 'switch order', {
        ...seatState,
        seatSwitches: [
          buildSwitch,
          planSwitch,
          { ...latest, toSeat: structured ? latest.toSeat : undefined },
          planSwitch,
        ],
      });
      consoleSpy.mockClear();
      await runStatus([]);
      expect(stripVTControlCharacters(captureOutput()).split('\n')).toContain(
        `Impl:     Claude Code CLI · Sonnet 5.5 · ${structured ? 'low' : 'high'}`,
      );
    }
  });

  it('prints the whole current identity across tool and model changes', async () => {
    const sessionId = '2026-10-13-current-tool';
    const ref = { projectDir: tmp, sessionId };
    const seatState = {
      implementerTool: 'codex',
      implementerModel: 'gpt-6.1-sol',
      implementerKind: 'cli',
    } as const;
    writeActiveSession(tmp, sessionId, 'current tool', seatState);
    recordSeatIdentities(
      ref,
      makeConfig({ implementer: { kind: 'cli', tool: 'codex', model: 'gpt-6.1-sol' } }),
    );
    writeActiveSession(tmp, sessionId, 'current tool', {
      ...seatState,
      seatSwitches: [
        {
          seat: 'build',
          from: 'OpenAI Codex CLI · GPT-6.1-Sol',
          to: 'Claude Code CLI · Sonnet 5.5 · max',
          toSeat: { tool: 'claude-code', model: 'sonnet', effort: 'max' },
          cause: 'runner-usage-limit',
          auto: false,
          configRevision: 'switched',
          ts: '2026-10-13T10:01:00.000Z',
        },
      ],
    });
    const replacement = makeConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet', effort: 'max' },
    });
    const changed = makeConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'high' },
    });
    for (const scenario of [
      { config: undefined, identity: 'Claude Code CLI · Sonnet 5.5 · max' },
      { config: replacement, identity: 'Claude Code CLI · Sonnet 5.5 · max' },
      { config: changed, identity: 'Claude Code CLI · Opus 5.5 · high' },
    ]) {
      if (scenario.config !== undefined) reconcileSeatIdentities(ref, scenario.config);
      consoleSpy.mockClear();
      await runStatus([]);
      expect(stripVTControlCharacters(captureOutput()).split('\n')).toContain(
        `Impl:     ${scenario.identity}`,
      );
    }
  });

  it('strips terminal controls from both seat identities', async () => {
    writeActiveSession(tmp, '2026-10-13-controls', 'seat controls', {
      plannerTool: '\u001b[31mcustom\u001b[0m',
      plannerModel: '\u001b[32mgpt-5\u001b[0m',
      implementerTool: 'opencode',
      implementerModel: 'opencode-go/\u001b[31mdeepseek-v4.1-flash\u001b[0m',
    });

    await runStatus([]);

    const seats = captureOutput()
      .split('\n')
      .filter((line) => /^(Planner|Impl):/.test(stripVTControlCharacters(line)));
    expect(seats).toHaveLength(2);
    for (const line of seats) {
      expect(line).not.toContain('\u001b[31m');
      expect(line).not.toContain('\u001b[32m');
    }
    expect(stripVTControlCharacters(captureOutput())).toContain(
      'Impl:     OpenCode CLI · opencode-go/deepseek-v4.1-flash',
    );
  });
});
