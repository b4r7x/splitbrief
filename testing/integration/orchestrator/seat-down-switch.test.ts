import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { Config } from '../../../src/core/schemas/config.js';
import type { Task } from '../../../src/core/schemas/task.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { runTrackedWorkflow, settleTrackedWorkflows } from '#testing/helpers/tracked-workflow.js';
import { applyOfferedSeatSwap } from '../../../src/engine/orchestrator/run/seat-swap.js';
import type { prepareExecution } from '../../../src/engine/runners/prepare-execution/prepare-execution.js';
import type { PreparationPolicy } from '../../../src/engine/runners/prepare-execution/types.js';
import type { PreparedExecution } from '../../../src/engine/runners/prepared-execution.js';
import { resolveCustomExecutable } from '../../../src/engine/runners/resolve-cli-executable.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cliDetectionFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { writeConfigYamlText } from '#testing/helpers/config-io.js';
import { prependPath } from '#testing/helpers/command-shim.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { typedCallFromTasks } from '#testing/helpers/typed-planner.js';

const AGENT_COMMAND = 'sb-seat-agent';
const TARGET = 'src/seat.ts';
const FALLBACK_MODEL = 'opencode/fallback-model';
const PARTIAL = 'export const seat = 0;';
const COMPLETE = 'export const seat = 1;';
const BALANCE_MESSAGE = 'Insufficient Balance (request_id: 021cfcdf-894e-4f9c-8e1b-85ac99f6a0fe)';
const BALANCE_LINE = `provider.quota: ${BALANCE_MESSAGE}`;
const ANTIGRAVITY_QUOTA_LINE =
  'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h6m30s.';
/** `opencode auth list --standalone --format json` with a credential for the fallback's provider. */
const AUTH_LISTING = JSON.stringify([
  { id: 'opencode', name: 'OpenCode Zen', connections: [{ type: 'credential' }] },
]);
/** A fallback on a provider the project's own `opencode.json` sets up, with no credential stored. */
const PROJECT_MODEL = 'ollama/llama3';
const PROJECT_OPENCODE_JSON = JSON.stringify({
  provider: { ollama: { npm: '@ai-sdk/openai-compatible', models: { llama3: {} } } },
});
/** `opencode api GET /api/model`: the project's providers only when the read names the project. */
const PROJECT_LISTING = JSON.stringify({ data: [{ id: 'llama3', providerID: 'ollama' }] });

const RESUME_POLICY: Extract<PreparationPolicy, { purpose: 'resume' }> = {
  purpose: 'resume',
  interaction: 'headless',
  allowRepoRunners: false,
  allowHooks: false,
  unverifiedAuth: 'denied',
};

const dirs: string[] = [];
const restores: Array<() => void> = [];
let originalPath: string | undefined;
let originalXdgStateHome: string | undefined;

beforeEach(() => {
  resetAllStores();
  originalPath = process.env.PATH;
  originalXdgStateHome = process.env.XDG_STATE_HOME;
  const stateHome = createTempDir('seat-down-switch-state');
  dirs.push(stateHome);
  process.env.XDG_STATE_HOME = stateHome;
});

afterEach(async () => {
  await settleTrackedWorkflows();
  vi.unstubAllEnvs();
  while (restores.length > 0) restores.pop()?.();
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdgStateHome;
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function writeExecutable(path: string, lines: readonly string[]): void {
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  chmodSync(path, 0o755);
}

/**
 * The failing seat: its runner kind and the lines it prints on each stream before it exits 1. The
 * Antigravity CLI seat stays alive after its lines, as `agy` does on a quota in the middle of a call.
 */
type FailingSeat = Readonly<{
  kind: 'agent' | 'shell' | 'antigravity';
  stdout: readonly string[];
  stderr: readonly string[];
}>;

const BALANCE_SEAT: FailingSeat = { kind: 'agent', stdout: [], stderr: [BALANCE_LINE] };

/** The failing seat's command: it writes a partial file, prints its lines, and exits or hangs. */
function writeSeatShim(dir: string, seat: FailingSeat): void {
  const print = (line: string, redirect: string) =>
    `printf '%s\\n' ${JSON.stringify(line)}${redirect}`;
  const command =
    seat.kind === 'antigravity' ? CLI_TOOL_CATALOG.antigravity.command : AGENT_COMMAND;
  writeExecutable(join(dir, command), [
    '#!/bin/bash',
    'cat >/dev/null 2>/dev/null || true',
    'mkdir -p src',
    `printf '%s\\n' '${PARTIAL}' > src/seat.ts`,
    ...seat.stdout.map((line) => print(line, '')),
    ...seat.stderr.map((line) => print(line, ' >&2')),
    seat.kind === 'antigravity' ? 'sleep 30' : 'exit 1',
  ]);
}

/** The fallback seat: an OpenCode CLI that answers on its JSON protocol. */
function writeOpencodeSuccessShim(dir: string, authListing: string): void {
  writeExecutable(join(dir, 'opencode'), [
    '#!/bin/bash',
    'if [[ " $* " == *" --version "* ]]; then printf \'opencode 2.0.14\\n\'; exit 0; fi',
    `if [[ "$1" == "auth" ]]; then printf '%s\\n' '${authListing}'; exit 0; fi`,
    `if [[ "$1" == "api" && "$6" == x-opencode-directory:* ]]; then printf '%s\\n' '${PROJECT_LISTING}'; exit 0; fi`,
    `if [[ "$1" == "api" ]]; then printf '%s\\n' '{"data":[]}'; exit 0; fi`,
    'cat >/dev/null',
    'mkdir -p src',
    `printf '%s\\n' '${COMPLETE}' > src/seat.ts`,
    `printf '%s\\n' '{"type":"text","timestamp":1,"sessionID":"ses_seat","part":{"type":"text","text":"implemented"}}'`,
    `printf '%s\\n' '{"type":"step_finish","timestamp":2,"sessionID":"ses_seat","part":{"type":"step-finish","tokens":{"input":10,"output":5}}}'`,
    'exit 0',
  ]);
}

/** The switched seat failing again: the same account refusal, as OpenCode reports it. */
function writeOpencodeFailureShim(dir: string): void {
  const envelope = JSON.stringify({
    type: 'error',
    error: { type: 'provider.quota', message: BALANCE_MESSAGE },
  });
  writeExecutable(join(dir, 'opencode'), [
    '#!/bin/bash',
    'if [[ " $* " == *" --version "* ]]; then printf \'opencode 2.0.14\\n\'; exit 0; fi',
    'cat >/dev/null',
    'mkdir -p src',
    "printf '%s\\n' 'export const seat = 2;' > src/seat.ts",
    `printf '%s\\n' '${envelope}'`,
    'exit 1',
  ]);
}

/** The live readiness check reads the shim's answers, never the operator's own tool state. */
function isolateHome(): void {
  const home = createTempDir('seat-down-switch-home');
  dirs.push(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  vi.stubEnv('XDG_DATA_HOME', join(home, '.local', 'share'));
}

function seatTask(): Task {
  return makeTask({
    id: 'T001',
    action: 'create',
    suggestedFiles: [TARGET],
    title: 'Add the seat module',
    description: 'Create src/seat.ts.',
    implementationSteps: ['Create src/seat.ts.'],
    tests: ['node -e "process.exit(0)"'],
    scope: { inBounds: [TARGET], outOfBounds: ['everything else'] },
    evidence: ['src/seat.ts exports seat'],
    typeDefs: 'export const seat: number',
  });
}

interface SeatDownRun {
  projectDir: string;
  sessionId: string;
  config: Config;
  prepared: PreparedExecution;
  halted: WorkflowState;
  partial: string;
}

/**
 * Drives the real orchestrator until the declared fallback's seat goes down: an
 * `agent` implementer built from config writes a partial file and then fails with
 * the provider's balance line, with a declared `fallback` and a remembered
 * readiness snapshot that lists it.
 */
async function runToFirstSeatDown(
  opencode: 'success' | 'fail',
  detection: 'remembered' | 'none' = 'remembered',
  route: 'gateway' | 'project-provider' = 'gateway',
  seat: FailingSeat = BALANCE_SEAT,
): Promise<SeatDownRun> {
  const projectDir = createTempDir(`seat-down-switch-${opencode}`);
  dirs.push(projectDir);
  createTestGitRepo(projectDir, {
    '.gitignore': '.splitbrief/\n',
    ...(route === 'project-provider' && { 'opencode.json': PROJECT_OPENCODE_JSON }),
  });
  const sessionId = `sess-seat-down-${opencode}`;

  const shimDir = createTempDir(`seat-down-shim-${opencode}`);
  dirs.push(shimDir);
  writeSeatShim(shimDir, seat);
  if (opencode === 'success') {
    writeOpencodeSuccessShim(shimDir, route === 'gateway' ? AUTH_LISTING : '[]');
  } else writeOpencodeFailureShim(shimDir);
  restores.push(prependPath(shimDir));

  const fallback = {
    tool: 'opencode',
    model: route === 'gateway' ? FALLBACK_MODEL : PROJECT_MODEL,
  } as const;
  const config = makeConfig({
    implementer:
      seat.kind === 'antigravity'
        ? { kind: 'cli', tool: 'antigravity', contextLength: 4096, fallback }
        : {
            kind: seat.kind,
            command: AGENT_COMMAND,
            model: 'agent-model',
            contextLength: 4096,
            fallback,
          },
    validation: { endChecks: false, testCommand: 'noop' },
    workflow: { approve: 'none' },
  });
  writeConfigYamlText(projectDir, YAML.stringify(config));
  if (detection === 'remembered') {
    await rememberDetectedTools(projectDir, [
      cliDetectionFor('ready', 'opencode'),
      cliDetectionFor('ready', 'claude-code'),
    ]);
  } else {
    isolateHome();
  }

  const agy =
    seat.kind === 'antigravity'
      ? await resolveCustomExecutable({ command: CLI_TOOL_CATALOG.antigravity.command, projectDir })
      : undefined;
  if (agy !== undefined && agy.kind !== 'resolved') throw new Error('the agy shim did not resolve');
  const prepared = makePreparedExecution({
    projectDir,
    sessionId,
    feature: 'seat down and switch',
    config,
    ...(agy !== undefined && {
      gates: (preparationId: string) => [
        makeRunnerGate(config.planner, { role: 'planner' }, preparationId),
        {
          kind: 'cli',
          slot: { role: 'implementer', profile: 'default' },
          preparationId,
          tool: 'antigravity',
          executable: agy.executable,
        },
      ],
    }),
  });

  await runTrackedWorkflow({
    prepared,
    callbacks: makeCallbacks().callbacks,
    sinks: TEST_WORKFLOW_SINKS,
    _planner: makePlanner({ typedCall: typedCallFromTasks([seatTask()]) }),
  });

  const halted = loadState({ projectDir, sessionId });
  if (halted === null) throw new Error('the halt saved no state');
  const workspace = halted.workspace;
  if (workspace === undefined) throw new Error('the halt recorded no workspace');
  return {
    projectDir,
    sessionId,
    config,
    prepared,
    halted,
    partial: readFileSync(join(workspace.path, TARGET), 'utf8'),
  };
}

/** Applies the auto intent the halt carries, through the same `applyOfferedSeatSwap` the run loop calls. */
async function applyAutoSwitch(run: SeatDownRun): Promise<{
  swapped: NonNullable<Awaited<ReturnType<typeof applyOfferedSeatSwap>>>;
  events: EngineEvent[];
}> {
  const intent = run.halted.pendingRecovery?.switchSeat?.auto;
  if (intent === undefined) throw new Error('the halt carried no automatic switch intent');

  const resolution = await resolveCustomExecutable({
    command: 'opencode',
    projectDir: run.projectDir,
  });
  if (resolution.kind !== 'resolved') throw new Error('the opencode shim did not resolve');

  const prepare = (async (request: Parameters<typeof prepareExecution>[0]) => {
    const execution = makePreparedExecution({
      projectDir: run.projectDir,
      sessionId: run.sessionId,
      feature: request.feature,
      config: request.effectiveConfig,
      ...(request.resumeState !== undefined && { resumeState: request.resumeState }),
      gates: (preparationId) => [
        {
          kind: 'cli',
          slot: { role: 'implementer', profile: 'default' },
          preparationId,
          tool: 'opencode',
          executable: resolution.executable,
        },
      ],
    });
    return { kind: 'prepared', execution } as const;
  }) as unknown as typeof prepareExecution;

  const { bus, events } = makeBusRecorder();
  const swapped = await applyOfferedSeatSwap({
    choice: { candidate: intent.candidate, policy: RESUME_POLICY },
    projectDir: run.projectDir,
    sessionId: run.sessionId,
    bus,
    config: run.config,
    prepared: run.prepared,
    savedState: run.halted,
    prepare,
  });
  if (swapped === undefined) throw new Error('the automatic seat switch was not applied');
  return { swapped, events };
}

async function continueRun(input: {
  prepared: PreparedExecution;
  savedState: WorkflowState;
}): Promise<{ summary: Awaited<ReturnType<typeof runTrackedWorkflow>>; events: EngineEvent[] }> {
  const events: EngineEvent[] = [];
  const summary = await runTrackedWorkflow({
    prepared: input.prepared,
    savedState: input.savedState,
    callbacks: makeCallbacks().callbacks,
    sinks: TEST_WORKFLOW_SINKS,
    _planner: makePlanner({ typedCall: typedCallFromTasks([seatTask()]) }),
    _eventSink: (event) => events.push(event),
  });
  return { summary, events };
}

describe('a spent implementer switches to its declared fallback', { timeout: 90_000 }, () => {
  it('switches on the auto intent and completes on the fallback', async () => {
    const run = await runToFirstSeatDown('success');

    const switchSeat = run.halted.pendingRecovery?.switchSeat;
    expect(run.halted.pendingRecovery?.reason).toBe('runner-usage-limit');
    expect(run.halted.pendingRecovery?.taskId).toBe('T001');
    expect(run.halted.pendingRecovery?.resetAt).toBeUndefined();
    expect(switchSeat?.seat).toBe('build');
    // The declared fallback leads the offer, so the halt can move the seat itself.
    expect(switchSeat?.candidates[0]?.tool).toBe('opencode');
    expect(switchSeat?.candidates[0]?.model).toBe(FALLBACK_MODEL);
    expect(switchSeat?.auto?.candidate).toEqual({ tool: 'opencode', model: FALLBACK_MODEL });
    expect(run.partial).toContain(PARTIAL);

    const { swapped, events } = await applyAutoSwitch(run);

    // The attempt is the brief's own, untouched by the move.
    expect(swapped.state.attempt).toBe(run.halted.attempt);
    expect(swapped.state.pendingRecovery).toBeUndefined();
    expect(swapped.state.seatSwitches).toHaveLength(1);
    expect(swapped.state.seatSwitches?.[0]?.auto).toBe(true);
    expect(swapped.state.seatSwitches?.[0]?.seat).toBe('build');

    // The fallback seat is what `config.yaml` now holds.
    const implementerOfRecord = loadConfig(run.projectDir).config.implementer;
    expect(implementerOfRecord).toMatchObject({ kind: 'cli', tool: 'opencode' });
    expect(implementerOfRecord).toMatchObject({ model: FALLBACK_MODEL });
    const configText = readFileSync(join(run.projectDir, SPLITBRIEF_DIR, CONFIG_FILE), 'utf8');
    expect(configText).toContain('opencode');

    const switchedEvent = events.find((event) => event.type === 'seat_switched');
    if (switchedEvent === undefined || switchedEvent.type !== 'seat_switched') {
      throw new Error('no seat_switched event');
    }
    expect(switchedEvent.auto).toBe(true);
    expect(switchedEvent.switchId).toEqual(expect.any(String));
    expect(switchedEvent.switchId).toBe(swapped.state.seatSwitches?.[0]?.switchId);
    expect(switchedEvent.seat).toBe('build');
    expect(switchedEvent.from).toMatchObject({ tool: 'agent' });
    expect(switchedEvent.to).toEqual({ tool: 'opencode', model: FALLBACK_MODEL });

    const workspace = swapped.state.workspace;
    if (workspace === undefined) throw new Error('the switched state recorded no workspace');
    // The partial the spent seat wrote is still in the run workspace.
    expect(existsSync(join(workspace.path, TARGET))).toBe(true);

    const { summary, events: resumed } = await continueRun({
      prepared: swapped.prepared,
      savedState: swapped.state,
    });

    expect(summary.totalTasks).toBe(1);
    expect(summary.completedByLocal).toBe(1);
    expect(summary.escalatedToPlanner).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.implementerTool).toBe('opencode');
    expect(resumed.some((event) => event.type === 'workflow_complete')).toBe(true);
    expect(readFileSync(join(workspace.path, TARGET), 'utf8')).toContain(COMPLETE);
  });

  it('switches on the auto intent when the project remembers no detection', async () => {
    const run = await runToFirstSeatDown('success', 'none');

    expect(existsSync(join(run.projectDir, SPLITBRIEF_DIR, 'detection-cache.json'))).toBe(false);
    expect(run.halted.pendingRecovery?.reason).toBe('runner-usage-limit');
    expect(run.halted.pendingRecovery?.switchSeat?.auto?.candidate).toEqual({
      tool: 'opencode',
      model: FALLBACK_MODEL,
    });

    const { swapped } = await applyAutoSwitch(run);
    expect(swapped.state.seatSwitches?.[0]?.auto).toBe(true);

    const { summary } = await continueRun({
      prepared: swapped.prepared,
      savedState: swapped.state,
    });
    expect(summary.completedByLocal).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.implementerTool).toBe('opencode');
  });

  it("switches to a fallback on a provider only the project's opencode.json sets up, with no credential and no remembered detection", async () => {
    const run = await runToFirstSeatDown('success', 'none', 'project-provider');

    expect(run.halted.pendingRecovery?.reason).toBe('runner-usage-limit');
    expect(run.halted.pendingRecovery?.switchSeat?.auto?.candidate).toEqual({
      tool: 'opencode',
      model: PROJECT_MODEL,
    });

    const { swapped } = await applyAutoSwitch(run);
    const { summary } = await continueRun({
      prepared: swapped.prepared,
      savedState: swapped.state,
    });
    expect(summary.completedByLocal).toBe(1);
    expect(summary.implementerTool).toBe('opencode');
  });

  it('switches when Antigravity reports its quota on stderr while the call stays alive', async () => {
    const started = Date.now();
    const run = await runToFirstSeatDown('success', 'remembered', 'gateway', {
      kind: 'antigravity',
      stdout: [],
      stderr: [ANTIGRAVITY_QUOTA_LINE],
    });

    // The seat sleeps 30 seconds after the line: the halt comes from the line, not from the exit.
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(run.halted.pendingRecovery?.reason).toBe('runner-usage-limit');
    expect(run.halted.pendingRecovery?.switchSeat?.auto?.candidate).toEqual({
      tool: 'opencode',
      model: FALLBACK_MODEL,
    });

    const { swapped } = await applyAutoSwitch(run);
    expect(swapped.state.seatSwitches?.[0]).toMatchObject({ seat: 'build', auto: true });

    const { summary } = await continueRun({
      prepared: swapped.prepared,
      savedState: swapped.state,
    });
    expect(summary.completedByLocal).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.implementerTool).toBe('opencode');
  });

  it('a second seat-down carries no auto intent', async () => {
    const run = await runToFirstSeatDown('fail');
    const { swapped } = await applyAutoSwitch(run);

    await continueRun({ prepared: swapped.prepared, savedState: swapped.state });

    const second = loadState({ projectDir: run.projectDir, sessionId: run.sessionId });
    if (second === null) throw new Error('the second halt saved no state');
    expect(second.pendingRecovery?.reason).toBe('runner-usage-limit');
    expect(second.pendingRecovery?.taskId).toBe('T001');
    // Only the other ready tool is offered; the run already auto-switched the build seat once.
    expect(second.pendingRecovery?.switchSeat?.candidates).toEqual([{ tool: 'claude-code' }]);
    expect(second.pendingRecovery?.switchSeat?.auto).toBeUndefined();
    expect(second.seatSwitches).toHaveLength(1);
  });
});

const LIMIT_LINE = "Error: You've hit your usage limit. Your limit resets at 3pm.";

describe('a seat that prints its halt only on stdout', { timeout: 90_000 }, () => {
  it.each([
    { kind: 'agent', name: 'Agent' },
    { kind: 'shell', name: 'Custom Shell' },
  ] as const)(
    'the $kind seat halts on its limit with the reset and switches to its fallback',
    async ({ kind, name }) => {
      const run = await runToFirstSeatDown('success', 'remembered', 'gateway', {
        kind,
        stdout: [LIMIT_LINE],
        stderr: [],
      });

      const recovery = run.halted.pendingRecovery;
      expect(recovery?.reason).toBe('runner-usage-limit');
      expect(recovery?.attempts).toBe(1);
      expect(recovery?.details).toContain(`${name} reported: ${LIMIT_LINE}`);
      const resetAt = new Date(recovery?.resetAt ?? Number.NaN);
      expect([resetAt.getHours(), resetAt.getMinutes()]).toEqual([15, 0]);
      expect(recovery?.switchSeat?.auto?.candidate).toEqual({
        tool: 'opencode',
        model: FALLBACK_MODEL,
      });
    },
  );

  it('halts on a sign-in refusal as signed out', async () => {
    const run = await runToFirstSeatDown('success', 'remembered', 'gateway', {
      kind: 'agent',
      stdout: ['Invalid API key · Please run /login'],
      stderr: [],
    });

    expect(run.halted.pendingRecovery?.reason).toBe('runner-unauthenticated');
    expect(run.halted.pendingRecovery?.attempts).toBe(1);
  });

  it('reads the stdout limit past unrelated stderr noise', async () => {
    const run = await runToFirstSeatDown('success', 'remembered', 'gateway', {
      kind: 'agent',
      stdout: [LIMIT_LINE],
      stderr: ['warning: deprecated flag'],
    });

    expect(run.halted.pendingRecovery?.reason).toBe('runner-usage-limit');
    expect(run.halted.pendingRecovery?.details).toContain(`Agent reported: ${LIMIT_LINE}`);
  });
});
