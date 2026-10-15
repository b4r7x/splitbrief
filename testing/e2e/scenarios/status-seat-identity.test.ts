import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { formatSeatIdentity } from '../../../src/core/crew/identity.js';
import { saveDetectionCache } from '../../../src/engine/detection/cache.js';
import { configWithSwitchedSeat } from '../../../src/engine/orchestrator/recovery/switch-seat.js';
import { SPLITBRIEF_DIR, sessionDir } from '../../../src/core/paths.js';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { recordSeatIdentities, reconcileSeatIdentities } from '../../../src/core/state/seats.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { spawnCli } from '../helpers/live-cli-harness.js';

let tmp: string;
let projectDir: string;
const sessionId = '2026-10-13-status';

beforeEach(() => {
  tmp = createTempDir('e2e-status-identities');
  projectDir = join(tmp, 'project');
  mkdirSync(sessionDir(projectDir, sessionId), { recursive: true });
  writeFileSync(join(projectDir, SPLITBRIEF_DIR, 'active'), `${sessionId}\n`);
});

afterEach(() => {
  cleanupTempDir(tmp);
});

function writeState(overrides: Partial<WorkflowState>): WorkflowState {
  const state: WorkflowState = {
    ...createInitialState('status identities', new Date('2026-10-13T10:00:00.000Z')),
    phase: 'implementing',
    ...overrides,
  };
  saveState({ projectDir, sessionId }, state);
  return state;
}

function status(): ReturnType<typeof spawnCli> {
  return spawnCli({
    args: ['--import', 'tsx', 'src/cli.ts', 'status', '--project', projectDir],
    stateHome: join(tmp, 'state'),
    timeoutMs: 30_000,
  });
}

it('names recorded seats from the remembered catalog in a fresh command', async () => {
  writeState({
    plannerTool: 'codex',
    plannerModel: 'gpt-6-luna',
    plannerKind: 'cli',
    implementerTool: 'codex',
    implementerModel: 'gpt-6-luna',
    implementerKind: 'cli',
  });
  await saveDetectionCache({
    projectDir,
    snapshot: {
      contextKey: 'remembered',
      fetchedAt: 1,
      validatedAt: 1,
      generation: 1,
      requestId: 1,
      providers: [],
      cliTools: [],
      cliCatalogs: [
        { tool: 'codex', models: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }], probedAt: 1 },
      ],
    },
  });

  const run = await status();
  expect(run.exitCode, run.stderr).toBe(0);
  expect(run.stdout).toContain('PLAN:     OpenAI Codex CLI · GPT-6-Luna');
  expect(run.stdout).toContain('BUILD:    OpenAI Codex CLI · GPT-6-Luna');
  expect(run.stdout).toContain('REVIEW:   OpenAI Codex CLI · GPT-6-Luna');
  expect(run.stdout).not.toContain('GPT-6 Luna');
});

it('prints readable OpenCode models with the same identities as the crew rows', async () => {
  const identities = [];
  for (const model of [
    'deepseek/deepseek-flash',
    'ollama-cloud/deepseek-v4.1-flash',
    'opencode-go/deepseek-v4.1-flash',
  ]) {
    const seat = { kind: 'cli', tool: 'opencode', model } as const;
    writeState({
      plannerTool: seat.tool,
      plannerModel: model,
      plannerKind: seat.kind,
      implementerTool: seat.tool,
      implementerModel: model,
      implementerKind: seat.kind,
    });

    const run = await status();
    expect(run.exitCode, run.stderr).toBe(0);
    const out = stripVTControlCharacters(run.stdout);
    const identity = formatSeatIdentity({ seat });
    expect(identity).toBe(`OpenCode CLI · DeepSeek V4.1 Flash · via ${model.split('/')[0]}`);
    expect(out).not.toContain(model);
    expect(out).toContain(`PLAN:     ${identity}`);
    expect(out).toContain(`BUILD:    ${identity}`);
    expect(out).toContain(`REVIEW:   ${identity}`);
    identities.push(out.split('\n').find((line) => line.startsWith('BUILD:')));
  }
  expect(new Set(identities).size).toBe(3);
});

it('prints Claude aliases and model-encoded axes with the same identities as the crew rows', async () => {
  const planner = {
    kind: 'cli',
    tool: 'claude-code',
    model: 'sonnet',
    effort: 'high',
  } as const;
  const implementer = {
    kind: 'cli',
    tool: 'cursor',
    model: 'claude-opus-5-thinking-xhigh-fast',
  } as const;
  writeState({
    plannerTool: planner.tool,
    plannerModel: planner.model,
    plannerKind: planner.kind,
    implementerTool: implementer.tool,
    implementerModel: implementer.model,
    implementerKind: implementer.kind,
  });
  recordSeatIdentities({ projectDir, sessionId }, makeConfig({ planner, implementer }));

  const run = await status();
  expect(run.exitCode, run.stderr).toBe(0);
  const out = stripVTControlCharacters(run.stdout);
  expect(out).toContain(`PLAN:     ${formatSeatIdentity({ seat: planner })}`);
  expect(out).toContain(`BUILD:    ${formatSeatIdentity({ seat: implementer })}`);
  expect(out).toContain(`REVIEW:   ${formatSeatIdentity({ seat: planner })}`);
  expect(out).toContain('Sonnet 5.5 · high');
  expect(out).toContain('Claude Opus 5 · xhigh · thinking · fast');
});

it.each(['high', 'max'] as const)(
  'prints %s after switching to max and resuming with that setting',
  async (effort) => {
    const ref = { projectDir, sessionId };
    const implementer = { kind: 'cli', tool: 'claude-code', model: 'sonnet' } as const;
    const state = writeState({
      implementerTool: implementer.tool,
      implementerModel: implementer.model,
      implementerKind: implementer.kind,
    });
    recordSeatIdentities(ref, makeConfig({ implementer: { ...implementer, effort: 'high' } }));
    saveState(
      ref,
      transition(state, {
        type: 'RECORD_SEAT_SWITCH',
        seat: 'build',
        from: 'Claude Code CLI · Sonnet 5.5 · high',
        to: 'Claude Code CLI · Sonnet 5.5 · max',
        toSeat: { tool: implementer.tool, model: implementer.model, effort: 'max' },
        cause: 'runner-usage-limit',
        auto: false,
        configRevision: 'switched',
      }),
    );
    reconcileSeatIdentities(ref, makeConfig({ implementer: { ...implementer, effort } }));

    const run = await status();

    expect(run.exitCode, run.stderr).toBe(0);
    expect(stripVTControlCharacters(run.stdout).split('\n')).toContain(
      `BUILD:    Claude Code CLI · Sonnet 5.5 · ${effort}`,
    );
  },
);

it('prints REVIEW as the switched PLAN seat when PLAN holds REVIEW, live and after resume', async () => {
  const ref = { projectDir, sessionId };
  const planner = { kind: 'cli', tool: 'claude-code', model: 'sonnet' } as const;
  const config = makeConfig({ planner });
  const state = writeState({
    plannerTool: planner.tool,
    plannerModel: planner.model,
    plannerKind: planner.kind,
  });
  recordSeatIdentities(ref, config);
  const toSeat = { tool: planner.tool, model: 'opus' };
  saveState(
    ref,
    transition(state, {
      type: 'RECORD_SEAT_SWITCH',
      seat: 'plan',
      from: 'Claude Code CLI · Sonnet 5.5',
      to: 'Claude Code CLI · Opus 5.5',
      toSeat,
      cause: 'runner-usage-limit',
      auto: false,
      configRevision: 'switched',
    }),
  );
  const seatLines = async (): Promise<string[]> => {
    const run = await status();
    expect(run.exitCode, run.stderr).toBe(0);
    return stripVTControlCharacters(run.stdout)
      .split('\n')
      .filter((line) => /^(PLAN|REVIEW):/.test(line));
  };
  const expected = ['PLAN:     Claude Code CLI · Opus 5.5', 'REVIEW:   Claude Code CLI · Opus 5.5'];

  expect(await seatLines()).toEqual(expected);

  const resumed = configWithSwitchedSeat(config, 'plan', toSeat);
  if (resumed === null) throw new Error('the plan seat refused the switch');
  expect(resumed.reviewer).toBeUndefined();
  reconcileSeatIdentities(ref, resumed);
  expect(await seatLines()).toEqual(expected);
});
