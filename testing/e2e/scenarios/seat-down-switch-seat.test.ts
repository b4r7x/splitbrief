import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type AppProps } from '../../../src/app/root.js';
import { canonicalizeProjectDir } from '../../../src/cli/setup.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { CONFIG_RELATIVE_PATH } from '../../../src/core/config/load/document.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { prepareExecution } from '../../../src/engine/runners/prepare-execution/prepare-execution.js';
import type { PreparedExecution } from '../../../src/engine/runners/prepared-execution.js';
import type { RunWorkflowFn } from '../../../src/features/workflow/hooks/use-run-loop.js';
import { preparationStore } from '../../../src/stores/navigation/preparation.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { lifecycleStore } from '../../../src/stores/workflow/lifecycle.js';
import { stopStore } from '../../../src/stores/workflow/stop.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeRunnerCallStarted } from '#testing/helpers/events/runner-call.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { heldUntilAborted, openHaltedRun } from '../helpers/halted-run-screen.js';
import {
  cli,
  continueWithCorrection,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const PRIMARY_MODEL = 'gpt-5-codex';
const SWITCHED_MODEL = 'sonnet';
let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof createTrustHome> | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  restorePath?.();
  trustHome?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  trustHome = undefined;
});

const WRITE_BOTH_FILES = `mkdirSync('src', { recursive: true });
  writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
  writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});`;

/**
 * Codex refuses on its account; Claude builds. With `haltedCallWrote` codex writes both files
 * before it refuses, and Claude finds them done and writes nothing. Every codex call waits while
 * `codexHold` exists.
 */
function installShims(
  binDir: string,
  codexCalls: string,
  claudeCalls: string,
  haltedCallWrote: boolean,
  codexHold: string,
): void {
  writeFakeNodeCli(
    binDir,
    'codex',
    `const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
while (existsSync(${JSON.stringify(codexHold)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (!args.includes('exec')) throw new Error('Unexpected codex invocation: ' + args.join(' '));
readFileSync(0, 'utf8');
appendFileSync(${JSON.stringify(codexCalls)}, JSON.stringify({ model: args.includes('--model') ? args[args.indexOf('--model') + 1] : null }) + '\\n');
${haltedCallWrote ? WRITE_BOTH_FILES : ''}
console.log(JSON.stringify({ type: 'error', message: 'Insufficient Balance' }));
process.exit(1);`,
  );
  writeFakeNodeCli(
    binDir,
    'claude',
    `const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('claude 2.1.296');
  process.exit(0);
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}
if (args[0] !== '-p') throw new Error('Unexpected claude invocation: ' + args.join(' '));
const emit = (entry) => console.log(JSON.stringify(entry));
const build = (prompt) => {
  appendFileSync(${JSON.stringify(claudeCalls)}, JSON.stringify({ model: args.includes('--model') ? args[args.indexOf('--model') + 1] : null, prompt }) + '\\n');
  ${haltedCallWrote ? '' : WRITE_BOTH_FILES}
  emit({ type: 'system', subtype: 'init', session_id: 'seat-switch-claude' });
  emit({ type: 'assistant', session_id: 'seat-switch-claude', message: { content: [{ type: 'text', text: 'Implemented the greeting helper.' }] } });
  emit({ type: 'result', result: 'Implemented the greeting helper.', session_id: 'seat-switch-claude', usage: { input_tokens: 100, output_tokens: 40 } });
};
if (args.includes('--input-format')) {
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.once('line', (line) => {
    const input = JSON.parse(line);
    const content = input.message.content;
    build(typeof content === 'string' ? content : JSON.stringify(content));
    lines.close();
    process.stdin.destroy();
  });
} else {
  build(readFileSync(0, 'utf8'));
}`,
  );
}

const GUIDANCE = JSON.stringify({
  answer: {
    diagnosis: 'The tool refused on its account.',
    action: 'guidance',
    instructions: 'Write src/greet.ts and src/marker.ts.',
    context: null,
  },
});

/** The project with BUILD on codex and both tools detected, before any run starts. */
async function codexSeatFixture(haltedCallWrote: boolean, implementerModel: string) {
  fixture = createStopContinueFixture(() => '', {
    isolation: 'none',
    // Anchored to the heading line: the plan prompt's repo map quotes this line of the script.
    consult: () =>
      `(prompt) => /^# Consult on a failing task$/m.test(prompt) ? ${JSON.stringify(GUIDANCE)} : undefined`,
  });
  const target = fixture;
  trustHome = createTrustHome('e2e-seat-switch-home');
  mkdirSync(join(trustHome.home, '.codex'), { recursive: true });
  writeFileSync(join(trustHome.home, '.codex', 'auth.json'), '{"fixture":true}\n');
  writeFileSync(join(trustHome.home, '.codex', 'config.toml'), `model = "${PRIMARY_MODEL}"\n`);
  mkdirSync(join(trustHome.home, '.claude'), { recursive: true });
  writeFileSync(join(trustHome.home, '.claude', '.credentials.json'), '{"fixture":true}\n');
  const binDir = join(target.tmpDir, 'bin');
  mkdirSync(binDir);
  const codexCalls = join(target.tmpDir, 'codex-calls.jsonl');
  const claudeCalls = join(target.tmpDir, 'claude-calls.jsonl');
  const codexHold = join(target.tmpDir, 'codex-hold');
  installShims(binDir, codexCalls, claudeCalls, haltedCallWrote, codexHold);
  restorePath = activateSafeCliShimPath(binDir);

  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    implementer: { kind: 'cli', tool: 'codex', model: implementerModel, contextLength: 200_000 },
  });
  expect(loadConfig(target.projectDir).config.implementer.fallback).toBeUndefined();

  const cliTools = await detectAvailableCliTools({
    projectDir: target.projectDir,
    tools: ['codex', 'claude-code'],
    authChannels: { codex: 'session', 'claude-code': 'session' },
    role: 'implementer',
  });
  expect(Object.fromEntries(cliTools.map((tool) => [tool.tool, tool.diagnostic.state]))).toEqual({
    codex: 'ready',
    'claude-code': 'ready',
  });
  await rememberDetectedTools(target.projectDir, cliTools);
  const offlinePreload = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePreload,
    "globalThis.fetch = async () => { throw new Error('Network disabled in seat switch E2E'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePreload}`);
  return { target, codexCalls, claudeCalls, codexHold };
}

async function codexHaltFixture(haltedCallWrote = false, implementerModel = PRIMARY_MODEL) {
  const { target, codexCalls, claudeCalls } = await codexSeatFixture(
    haltedCallWrote,
    implementerModel,
  );
  const options = { timeoutMs: 90_000, reapProjectDir: target.projectDir };
  const halted = await cli(target, ['start', 'smoke'], options);
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0] ?? '';
  return { target, halted, sessionId, codexCalls, claudeCalls, options };
}

function recordedCalls(callsPath: string): unknown[] {
  return readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('e2e: seat down without a fallback, switched by hand', { timeout: 240_000 }, () => {
  it('halts BUILD on an account refusal, then finishes the run on the tool switch-seat names', async () => {
    const { target, halted, sessionId, codexCalls, claudeCalls, options } =
      await codexHaltFixture();
    const ref = { projectDir: target.projectDir, sessionId };
    const haltState = loadState(ref);

    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    expect(halted.stderr).toContain('Seat down (runner-usage-limit)');
    expect(halted.stderr).toContain(
      `Continue with: splitbrief continue ${sessionId} --action switch-seat:claude-code`,
    );
    expect(haltState?.pendingRecovery).toMatchObject({
      reason: 'runner-usage-limit',
      status: 'awaiting-user',
      seat: 'build',
      taskId: 'T001',
      recommendedAction: 'switch-seat',
      switchSeat: {
        seat: 'build',
        candidates: expect.arrayContaining([expect.objectContaining({ tool: 'claude-code' })]),
      },
    });
    expect(haltState?.pendingRecovery?.switchSeat?.auto).toBeUndefined();
    expect(haltState?.pendingRecovery?.availableActions).toContain('switch-seat');
    expect(haltState?.pendingRecovery?.details).toContain('no fallback set');
    expect(haltState?.seatSwitches ?? []).toEqual([]);
    expect(recordedCalls(codexCalls)).toEqual([{ model: PRIMARY_MODEL }]);
    expect(existsSync(claudeCalls)).toBe(false);

    const switched = await cli(
      target,
      ['continue', sessionId, '--action', `switch-seat:claude-code:${SWITCHED_MODEL}`],
      options,
    );
    const state = loadState(ref);
    expect(
      switched.exitCode,
      `${switched.stdout}\n${switched.stderr}\n${JSON.stringify(state?.pendingRecovery, null, 2)}`,
    ).toBe(0);
    expect(switched.stderr).toContain(`BUILD seat recorded in ${CONFIG_RELATIVE_PATH}`);
    expect(switched.stdout).toContain('task T001: done');
    expect(state?.phase).toBe('complete');
    expect(state?.pendingRecovery).toBeUndefined();
    expect(state?.reviewStatus).toBe('passed');
    expect(state?.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
    expect(state?.seatSwitches).toEqual([
      expect.objectContaining({
        seat: 'build',
        from: 'OpenAI Codex CLI · GPT-5 Codex',
        to: expect.stringContaining('Claude Code CLI'),
        cause: 'runner-usage-limit',
        auto: false,
        configRevision: expect.any(String),
      }),
    ]);
    expect(recordedCalls(codexCalls)).toEqual([{ model: PRIMARY_MODEL }]);
    expect(recordedCalls(claudeCalls)).toEqual([
      { model: SWITCHED_MODEL, prompt: expect.stringContaining(GREET_FILE) },
    ]);
    const implementer = loadConfig(target.projectDir).config.implementer;
    expect(implementer).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: SWITCHED_MODEL,
    });
    expect(implementer.fallback).toBeUndefined();
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
  });

  it('refuses a tool the halt did not offer and keeps the halt pending', async () => {
    const { target, halted, sessionId, codexCalls, claudeCalls, options } =
      await codexHaltFixture();
    const ref = { projectDir: target.projectDir, sessionId };
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    const haltState = loadState(ref);
    expect(haltState?.pendingRecovery?.reason).toBe('runner-usage-limit');

    const refused = await cli(
      target,
      ['continue', sessionId, '--action', 'switch-seat:opencode'],
      options,
    );
    expect(refused.exitCode, `${refused.stdout}\n${refused.stderr}`).toBe(1);
    expect(refused.stderr).toContain(
      "'opencode' is not one of the tools offered for the build seat.",
    );
    const state = loadState(ref);
    expect(state?.pendingRecovery).toEqual(haltState?.pendingRecovery);
    expect(state?.seatSwitches ?? []).toEqual([]);
    expect(loadConfig(target.projectDir).config.implementer).toMatchObject({
      kind: 'cli',
      tool: 'codex',
      model: PRIMARY_MODEL,
    });
    expect(recordedCalls(codexCalls)).toEqual([{ model: PRIMARY_MODEL }]);
    expect(existsSync(claudeCalls)).toBe(false);
  });
});

async function taskRetries(ref: { projectDir: string; sessionId: string }): Promise<string[]> {
  const { events } = await readRunEvents(ref);
  return events.flatMap((event) => (event.type === 'task_retry' ? [event.error] : []));
}

describe('e2e: seat down after the brief wrote its files', { timeout: 240_000 }, () => {
  it('passes the brief on the kept work when the switched seat changes nothing', async () => {
    const { target, halted, sessionId, claudeCalls, options } = await codexHaltFixture(true);
    const ref = { projectDir: target.projectDir, sessionId };
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    expect(loadState(ref)?.pendingRecovery?.reason).toBe('runner-usage-limit');

    const switched = await cli(
      target,
      ['continue', sessionId, '--action', `switch-seat:claude-code:${SWITCHED_MODEL}`],
      options,
    );
    expect(switched.exitCode, `${switched.stdout}\n${switched.stderr}`).toBe(0);
    expect(switched.stdout).toContain('task T001: done');
    expect(loadState(ref)?.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
    expect(recordedCalls(claudeCalls)).toHaveLength(1);
    expect(await taskRetries(ref)).toEqual([]);
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
    expect(readFileSync(target.markerPath, 'utf8')).toBe(MARKER_SOURCE);
  });

  it('passes the brief on the kept work when the switch carries a typed correction', async () => {
    const { target, halted, sessionId, claudeCalls } = await codexHaltFixture(true);
    const ref = { projectDir: target.projectDir, sessionId };
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    const correction = 'Both files are written. Check them and keep them.';
    vi.stubGlobal('fetch', async () => {
      throw new Error('Network disabled in seat switch E2E');
    });

    const resumed = await continueWithCorrection(target, sessionId, correction, {
      action: `switch-seat:claude-code:${SWITCHED_MODEL}`,
    });
    expect(resumed.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
    expect(recordedCalls(claudeCalls)).toEqual([
      { model: SWITCHED_MODEL, prompt: expect.stringContaining(correction) },
    ]);
    expect(await taskRetries(ref)).toEqual([]);
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
    expect(readFileSync(target.markerPath, 'utf8')).toBe(MARKER_SOURCE);
  });
});

async function preparedResume(ref: SessionRef, state: WorkflowState): Promise<PreparedExecution> {
  const outcome = await prepareExecution({
    existingSession: ref,
    feature: state.feature,
    effectiveConfig: loadConfig(ref.projectDir).config,
    resumeState: state,
    signal: new AbortController().signal,
    policy: {
      purpose: 'resume',
      interaction: 'headless',
      allowRepoRunners: true,
      allowHooks: false,
      unverifiedAuth: 'allowed',
    },
  });
  if (outcome.kind !== 'prepared') throw new Error(`the resume was not prepared: ${outcome.kind}`);
  return outcome.execution;
}

describe('e2e: seat down switched from the recovery menu', { timeout: 150_000 }, () => {
  it('moves BUILD to the picked tool without announcing a pause at the brief boundary', async () => {
    const { target } = await codexHaltFixture();
    vi.stubGlobal('fetch', async () => {
      throw new Error('Network disabled in seat switch E2E');
    });
    await trustDeclaredRunners({
      projectDir: target.projectDir,
      config: loadConfig(target.projectDir).config,
    });
    let engineCalls = 0;
    const { screen, runWorkflow: engine } = await openHaltedRun(target, {
      heading: 'Seat down',
      prepare: ({ ref, state }) => preparedResume(ref, state),
      // The first entry is the real engine, so the halt is raised in this process the way a run
      // started on this screen raises it. Every later entry stays open for the test to read.
      runWorkflow: (opts) => {
        engineCalls += 1;
        return engineCalls === 1 ? runWorkflow(opts) : heldUntilAborted(opts.signal);
      },
    });
    const frame = () => stripAnsiStyles(screen.lastFrame());
    const press = async (key: string) => {
      screen.stdin.write(key);
      await flushEffects();
      await tick(100);
    };
    try {
      await press('\u001B[A');
      await press('\r');
      await vi.waitFor(() => expect(frame()).toContain('Run continued'));
      await vi.waitFor(() => expect(frame()).toContain('Change BUILD tool'), { timeout: 60_000 });
      expect(engine).toHaveBeenCalledTimes(1);
      expect(lifecycleStore.get().status).toBe('running');

      await press('\r');
      await vi.waitFor(() => expect(frame()).toContain('BUILD · tool, model, effort'));
      // This screen opened without the startup detection, so the picker reads the tools now.
      await press('\u0012');
      await vi.waitFor(() => expect(frame()).toContain('Sonnet 5.5'), { timeout: 30_000 });

      const intents: string[] = [];
      const offStop = stopStore.subscribe(() => intents.push(stopStore.get().intent));
      const firstFrame = screen.frames.length;
      await press('\u001B[B');
      await press('\r');
      await press('\r');
      await vi.waitFor(() => expect(engine).toHaveBeenCalledTimes(2), { timeout: 60_000 });
      offStop();

      expect(engine.mock.calls[1]?.[0].prepared.config.implementer).toMatchObject({
        kind: 'cli',
        tool: 'claude-code',
      });
      const shown = screen.frames.slice(firstFrame).map(stripAnsiStyles).join('\n');
      expect(shown).not.toContain('Pause requested');
      expect(shown).not.toContain('Finishing T001');
      expect(intents).not.toContain('pause-after-brief');
    } finally {
      screen.unmount();
    }
  });
});

describe('e2e: a setting saved while the brief runs', { timeout: 150_000 }, () => {
  it('announces no pause when the save changes no seat of a seat left to its tool', async () => {
    const { target, halted } = await codexHaltFixture(false, 'auto');
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    vi.stubGlobal('fetch', async () => {
      throw new Error('Network disabled in seat switch E2E');
    });
    await trustDeclaredRunners({
      projectDir: target.projectDir,
      config: loadConfig(target.projectDir).config,
    });
    const { screen, runWorkflow: engine } = await openHaltedRun(target, {
      heading: 'Seat down',
      prepare: ({ ref, state }) => preparedResume(ref, state),
      // The retried brief starts its implementer call and keeps it open for the test to read.
      runWorkflow: (opts) => {
        opts.tuiSink?.(makeRunnerCallStarted({ ts: Date.now(), runnerName: 'codex' }));
        return heldUntilAborted(opts.signal);
      },
    });
    const frame = () => stripAnsiStyles(screen.lastFrame());
    const press = async (key: string) => {
      screen.stdin.write(key);
      await flushEffects();
      await tick(100);
    };
    try {
      await press('\u001B[A');
      await press('\r');
      await vi.waitFor(() => expect(engine).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(frame()).toContain('Implementing…'));
      expect(lifecycleStore.get().status).toBe('running');
      // Preparation names the model codex keeps in its own config; the saved seat stays on auto.
      expect(engine.mock.calls[0]?.[0].prepared.config.implementer).toMatchObject({
        tool: 'codex',
        model: PRIMARY_MODEL,
      });
      const current = configStore.get().config;
      if (current === null) throw new Error('the screen loaded no config');
      expect(current.implementer).toMatchObject({ tool: 'codex', model: 'auto' });

      const intents: string[] = [];
      const offStop = stopStore.subscribe(() => intents.push(stopStore.get().intent));
      const firstFrame = screen.frames.length;
      const saved = await configStore.save({
        ...current,
        workflow: { ...current.workflow, approve: 'none' },
      });
      await flushEffects();
      await tick(200);
      offStop();

      expect(saved.kind).toBe('saved');
      const shown = screen.frames.slice(firstFrame).map(stripAnsiStyles).join('\n');
      expect(shown).not.toContain('Pause requested');
      expect(shown).not.toContain('Finishing T001');
      expect(intents).not.toContain('pause-after-brief');
    } finally {
      screen.unmount();
    }
  });
});

describe('e2e: a BUILD seat saved while the start check runs', { timeout: 150_000 }, () => {
  it('builds from the first brief boundary on the seat saved during the check', async () => {
    const { target, codexHold } = await codexSeatFixture(false, PRIMARY_MODEL);
    vi.stubGlobal('fetch', async () => {
      throw new Error('Network disabled in seat switch E2E');
    });
    vi.stubEnv('XDG_STATE_HOME', target.stateHome);
    const projectDir = await canonicalizeProjectDir({ project: target.projectDir });
    // Home admits no command from the repository, so PLAN is a coding tool here.
    const config = loadConfig(projectDir).config;
    writeConfig(projectDir, {
      ...config,
      planner: { kind: 'cli', tool: 'claude-code', model: SWITCHED_MODEL, contextLength: 200_000 },
    });
    await trustDeclaredRunners({ projectDir, config: loadConfig(projectDir).config });
    configStore.load(projectDir);
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    routerStore.init({ screen: 'home' });
    // The first entry is the run the check prepared: it reaches its first brief boundary at once.
    // The entry after it stays open for the test to read.
    const runWorkflow = vi.fn<RunWorkflowFn>(async (opts) => {
      if (runWorkflow.mock.calls.length > 1) return heldUntilAborted(opts.signal);
      saveState(opts.prepared.session.ref, {
        ...createInitialState(opts.prepared.runtime.feature),
        phase: 'implementing',
      });
      if (!opts.sinks.consumeBoundaryPause?.()) return heldUntilAborted(opts.signal);
      await opts.callbacks.onContinuationNeeded?.('', 'boundary', []);
      return makeSummary();
    });
    const screen = renderFeature(createElement<AppProps>(App, { workflowDeps: { runWorkflow } }), {
      cols: 120,
      rows: 40,
    });
    const frame = () => stripAnsiStyles(screen.lastFrame());
    try {
      await flushEffects();
      screen.stdin.write('smoke');
      await vi.waitFor(() => expect(frame()).toContain('smoke'));
      writeFileSync(codexHold, '');
      screen.stdin.write('\r');
      await vi.waitFor(() => expect(frame()).toContain('Checking tools'), { timeout: 30_000 });

      screen.stdin.write('\u001B[44;5u');
      await vi.waitFor(() => expect(overlayStore.get().active).toBe('settings'));
      const current = configStore.get().config;
      if (current === null) throw new Error('the screen loaded no config');
      const saved = await configStore.save({
        ...current,
        implementer: {
          kind: 'cli',
          tool: 'claude-code',
          model: SWITCHED_MODEL,
          contextLength: 200_000,
        },
      });
      expect(saved.kind).toBe('saved');
      expect(preparationStore.get().kind).toBe('checking');
      overlayStore.close();
      rmSync(codexHold);

      await vi.waitFor(() => expect(runWorkflow).toHaveBeenCalledTimes(2), { timeout: 60_000 });
      expect(runWorkflow.mock.calls[0]?.[0].prepared.config.implementer).toMatchObject({
        tool: 'codex',
      });
      expect(runWorkflow.mock.calls[1]?.[0].prepared.config.implementer).toMatchObject({
        tool: 'claude-code',
        model: SWITCHED_MODEL,
      });
    } finally {
      screen.unmount();
    }
  });
});
