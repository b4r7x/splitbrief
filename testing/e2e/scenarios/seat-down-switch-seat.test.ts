import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type AppProps } from '../../../src/app/root.js';
import { canonicalizeProjectDir } from '../../../src/cli/setup.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { CONFIG_RELATIVE_PATH } from '../../../src/core/config/load/document.js';
import { sessionDir, sessionsRoot } from '../../../src/core/paths.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { Config } from '../../../src/core/schemas/config.js';
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
import { makeTaskStart } from '#testing/helpers/events/task.js';
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
  const { target, codexCalls, claudeCalls, codexHold } = await codexSeatFixture(
    haltedCallWrote,
    implementerModel,
  );
  const options = { timeoutMs: 90_000, reapProjectDir: target.projectDir };
  const halted = await cli(target, ['start', 'smoke'], options);
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0] ?? '';
  return { target, halted, sessionId, codexCalls, claudeCalls, codexHold, options };
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

  it.each([
    ['BUILD', (current: Config) => claudeOnBuild(current), ['\r', '\r']],
    [
      'REVIEW',
      (current: Config): Config => ({
        ...current,
        reviewer: { kind: 'cli', tool: 'codex', model: PRIMARY_MODEL },
      }),
      ['\u001B[B', '\r', '\r'],
    ],
  ] as const)(
    'starts the next brief with no pause when a %s seat saved under the brief is taken by the swap',
    async (_label, save, keys) => {
      const { target, codexHold } = await codexHaltFixture();
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
        // Try again: the retried codex call waits on the hold, so the brief runs while the seat is saved.
        writeFileSync(codexHold, '');
        await press('\u001B[A');
        await press('\r');
        await vi.waitFor(() => expect(frame()).toContain('Run continued'));
        expect(engine).toHaveBeenCalledTimes(1);
        const current = configStore.get().config;
        if (current === null) throw new Error('the screen loaded no config');
        const saved = await configStore.save(save(current));
        expect(saved.kind).toBe('saved');
        await vi.waitFor(() => expect(frame()).toContain('Seat changes after T001'));
        rmSync(codexHold);

        // The same brief halts with Seat down on BUILD, and Change BUILD tool takes a row.
        await vi.waitFor(() => expect(frame()).toContain('Change BUILD tool'), { timeout: 60_000 });
        await press('\r');
        await vi.waitFor(() => expect(frame()).toContain('BUILD · tool, model, effort'));
        await press('\u0012');
        await vi.waitFor(() => expect(frame()).toContain('claude-opus-5-5'), { timeout: 30_000 });
        for (const key of keys) await press(key);
        await vi.waitFor(() => expect(engine).toHaveBeenCalledTimes(2), { timeout: 60_000 });
        await tick(200);

        const run = engine.mock.calls[1]?.[0].prepared.config;
        expect(run?.implementer).toMatchObject({ kind: 'cli', tool: 'claude-code' });
        expect(run?.reviewer).toEqual(configStore.get().config?.reviewer);
        // The swap took every seat saved under the brief: no pause waits at its boundary.
        expect(stopStore.get()).toMatchObject({ intent: 'none', seatChange: false });
        expect(lifecycleStore.get().status).toBe('running');
        expect(frame()).not.toContain('Seat changes after');
      } finally {
        screen.unmount();
      }
    },
  );
});

/** Claude Code saved on BUILD: the tool the halt offers. */
function claudeOnBuild(current: Config): Config {
  return {
    ...current,
    implementer: {
      kind: 'cli',
      tool: 'claude-code',
      model: SWITCHED_MODEL,
      contextLength: 200_000,
    },
  };
}

describe('e2e: a seat saved while the Seat down halt waits', { timeout: 150_000 }, () => {
  /** The CLI halt opened on the screen, with `save` written while the halt waits. */
  async function haltWithSavedSeat(
    save: (current: Config) => Config = claudeOnBuild,
    engineFn: RunWorkflowFn = runWorkflow,
  ) {
    const { target, sessionId, codexCalls, claudeCalls } = await codexHaltFixture();
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
      runWorkflow: engineFn,
    });
    const frame = () => stripAnsiStyles(screen.lastFrame());
    const press = async (key: string) => {
      screen.stdin.write(key);
      await flushEffects();
      await tick(100);
    };
    const intents: string[] = [];
    const offStop = stopStore.subscribe(() => intents.push(stopStore.get().intent));
    const firstFrame = screen.frames.length;
    const current = configStore.get().config;
    if (current === null) throw new Error('the screen loaded no config');
    const saved = await configStore.save(save(current));
    expect(saved.kind).toBe('saved');
    await flushEffects();
    const ref = { projectDir: target.projectDir, sessionId };
    /** What the run did after the save: it ran once, on the saved seat, and passed its brief. */
    const expectRanOnSavedSeat = async () => {
      await vi.waitFor(
        () => {
          const now = loadState(ref);
          const seen = { halt: now?.pendingRecovery?.reason, codex: recordedCalls(codexCalls) };
          expect(now?.phase, JSON.stringify(seen)).toBe('complete');
        },
        { timeout: 60_000 },
      );
      offStop();
      const state = loadState(ref);
      expect(engine).toHaveBeenCalledTimes(1);
      expect(engine.mock.calls[0]?.[0].prepared.config.implementer).toMatchObject({
        kind: 'cli',
        tool: 'claude-code',
        model: SWITCHED_MODEL,
      });
      expect(state?.pendingRecovery).toBeUndefined();
      expect(state?.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
      expect(recordedCalls(codexCalls)).toEqual([{ model: PRIMARY_MODEL }]);
      expect(recordedCalls(claudeCalls)).toEqual([
        { model: SWITCHED_MODEL, prompt: expect.stringContaining(GREET_FILE) },
      ]);
      const shown = screen.frames.slice(firstFrame).map(stripAnsiStyles).join('\n');
      expect(shown).not.toContain('Pause requested');
      expect(shown).not.toContain('Finishing T001');
      expect(intents).not.toContain('pause-after-brief');
      const { events } = await readRunEvents(ref);
      const switches = events.filter((event) => event.type === 'seat_switched');
      return { state, switches };
    };
    /** Change BUILD tool, then `keys` take a Claude Code model row in the picker. */
    const pickClaudeInPicker = async (keys: readonly string[]) => {
      await press('\r');
      await vi.waitFor(() => expect(frame()).toContain('BUILD · tool, model, effort'));
      // This screen opened without the startup detection, so the picker reads the tools now.
      await press('\u0012');
      // The saved seat already reads Sonnet 5.5, so wait for a model row of the refreshed list.
      await vi.waitFor(() => expect(frame()).toContain('claude-opus-5-5'), { timeout: 30_000 });
      for (const key of keys) await press(key);
      await vi.waitFor(() => expect(overlayStore.get().active).toBe('none'));
    };
    /** Change BUILD tool, then the picker closed with Escape and no row taken. */
    const closePickerWithNoPick = async () => {
      await press('\r');
      await vi.waitFor(() => expect(frame()).toContain('BUILD · tool, model, effort'));
      await press('\u001B');
      await vi.waitFor(() => expect(overlayStore.get().active).toBe('none'));
      await vi.waitFor(() => expect(frame()).toContain('Change BUILD tool'));
    };
    const shownSinceSave = () => screen.frames.slice(firstFrame).map(stripAnsiStyles).join('\n');
    return {
      screen,
      press,
      engine,
      expectRanOnSavedSeat,
      pickClaudeInPicker,
      closePickerWithNoPick,
      shownSinceSave,
    };
  }

  it('runs Try again on the saved seat and passes the brief with no second halt', async () => {
    const { screen, press, expectRanOnSavedSeat } = await haltWithSavedSeat();
    try {
      await press('\u001B[A');
      await press('\r');
      const { state, switches } = await expectRanOnSavedSeat();
      // A seat saved outside the halt is the user's crew change, logged once and not a switch.
      expect(switches).toEqual([
        expect.objectContaining({ seat: 'build', cause: 'crew-changed', auto: false }),
      ]);
      expect(state?.seatSwitches).toBeUndefined();
    } finally {
      screen.unmount();
    }
  });

  it('switches to the saved tool when Change BUILD tool takes its row', async () => {
    const { screen, expectRanOnSavedSeat, pickClaudeInPicker } = await haltWithSavedSeat();
    try {
      // The picker opens on the saved Sonnet row; ⏎ opens its effort and ⏎ takes the row.
      await pickClaudeInPicker(['\r', '\r']);
      const { state, switches } = await expectRanOnSavedSeat();
      expect(switches).toEqual([
        expect.objectContaining({ seat: 'build', cause: 'runner-usage-limit', auto: false }),
      ]);
      expect(state?.seatSwitches).toEqual([
        expect.objectContaining({ seat: 'build', cause: 'runner-usage-limit', auto: false }),
      ]);
    } finally {
      screen.unmount();
    }
  });

  it('keeps the halt when the picker closes with no pick, and Try again runs the saved seat', async () => {
    const { screen, press, engine, expectRanOnSavedSeat, closePickerWithNoPick } =
      await haltWithSavedSeat();
    try {
      await closePickerWithNoPick();
      expect(engine).not.toHaveBeenCalled();

      await press('\u001B[A');
      await press('\r');
      const { state, switches } = await expectRanOnSavedSeat();
      expect(switches).toEqual([
        expect.objectContaining({ seat: 'build', cause: 'crew-changed', auto: false }),
      ]);
      expect(state?.seatSwitches).toBeUndefined();
    } finally {
      screen.unmount();
    }
  });

  it('shows no switch warning when the picker closes with no pick on a saved tool the halt does not offer', async () => {
    const codexOnAuto = (current: Config): Config => ({
      ...current,
      implementer: { kind: 'cli', tool: 'codex', model: 'auto', contextLength: 200_000 },
    });
    const { screen, engine, closePickerWithNoPick, shownSinceSave } = await haltWithSavedSeat(
      codexOnAuto,
      (opts) => heldUntilAborted(opts.signal),
    );
    try {
      await closePickerWithNoPick();
      await tick(200);

      expect(engine).not.toHaveBeenCalled();
      expect(shownSinceSave()).not.toContain('Could not switch');
      expect(configStore.get().config?.implementer).toMatchObject({ tool: 'codex', model: 'auto' });
    } finally {
      screen.unmount();
    }
  });

  it('keeps the halt when Escape closes the picker after Ctrl+D removed a custom model, and Try again runs the saved seat', async () => {
    const claudeWithCustomModels = (current: Config): Config => ({
      ...current,
      implementer: {
        kind: 'cli',
        tool: 'claude-code',
        model: SWITCHED_MODEL,
        contextLength: 200_000,
        customModels: ['my-a', 'my-b'],
      },
    });
    const { screen, press, engine, expectRanOnSavedSeat, shownSinceSave } =
      await haltWithSavedSeat(claudeWithCustomModels);
    const frame = () => stripAnsiStyles(screen.lastFrame());
    try {
      await press('\r');
      await vi.waitFor(() => expect(frame()).toContain('BUILD · tool, model, effort'));
      await press('\u001B[C');
      for (let moves = 0; moves < 20 && !/\| \| My B/.test(frame()); moves += 1) {
        await press('\u001B[B');
      }
      expect(frame()).toMatch(/\| \| My B/);
      await press('\u0004');
      await vi.waitFor(() =>
        expect(configStore.get().config?.implementer).toMatchObject({ customModels: ['my-a'] }),
      );
      expect(overlayStore.get().active).toBe('implementer-picker');
      await press('\u001B');
      await vi.waitFor(() => expect(overlayStore.get().active).toBe('none'));
      await vi.waitFor(() => expect(frame()).toContain('Change BUILD tool'));
      await tick(200);
      expect(engine).not.toHaveBeenCalled();
      expect(shownSinceSave()).not.toContain('Could not switch');

      await press('\u001B[A');
      await press('\r');
      const { state, switches } = await expectRanOnSavedSeat();
      expect(switches).toEqual([
        expect.objectContaining({ seat: 'build', cause: 'crew-changed', auto: false }),
      ]);
      expect(state?.seatSwitches).toBeUndefined();
    } finally {
      screen.unmount();
    }
  });

  it('keeps a REVIEW seat saved under the BUILD halt when Change BUILD tool picks another tool', async () => {
    const codexOnReview = (current: Config): Config => ({
      ...current,
      reviewer: { kind: 'cli', tool: 'codex', model: PRIMARY_MODEL },
    });
    const { screen, engine, pickClaudeInPicker } = await haltWithSavedSeat(codexOnReview, (opts) =>
      heldUntilAborted(opts.signal),
    );
    const frame = () => stripAnsiStyles(screen.lastFrame());
    try {
      await pickClaudeInPicker(['\u001B[B', '\r', '\r']);
      await vi.waitFor(() => expect(engine).toHaveBeenCalledTimes(1), { timeout: 60_000 });

      const run = engine.mock.calls[0]?.[0].prepared.config;
      expect(run?.implementer).toMatchObject({ kind: 'cli', tool: 'claude-code' });
      expect(run?.reviewer).toMatchObject({ kind: 'cli', tool: 'codex', model: PRIMARY_MODEL });
      expect(configStore.get().config?.reviewer).toMatchObject({ kind: 'cli', tool: 'codex' });

      overlayStore.open('settings');
      await vi.waitFor(() => expect(frame()).toMatch(/REVIEW[^\n]*Codex/));
      expect(frame()).toMatch(/BUILD[^\n]*Claude Code/);
    } finally {
      overlayStore.close();
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
  // The seat waits through the plan card and the first brief, which read `Finishing the run` and
  // `Pause requested; no next brief will start` while the run went on.
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
    // The first entry is the run the check prepared: its plan card waits for an answer, its first
    // brief runs until the test has read it, and then it reaches its first brief boundary. The
    // entry after it stays open for the test to read.
    const { promise: briefRead, resolve: briefReadNow } = Promise.withResolvers<void>();
    const runWorkflow = vi.fn<RunWorkflowFn>(async (opts) => {
      if (runWorkflow.mock.calls.length > 1) return heldUntilAborted(opts.signal);
      const { ref } = opts.prepared.session;
      saveState(ref, {
        ...createInitialState(opts.prepared.runtime.feature),
        phase: 'implementing',
      });
      const planPath = join(sessionDir(ref.projectDir, ref.sessionId), 'plan.md');
      writeFileSync(planPath, '# Plan\n\nGreet the user\n');
      await opts.callbacks.onApprovalNeeded('plan', planPath, []);
      opts.tuiSink?.(makeTaskStart({ total: 2 }));
      await briefRead;
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
      const firstFrame = screen.frames.length;
      rmSync(codexHold);

      await vi.waitFor(() => expect(frame()).toContain('Greet the user'), { timeout: 60_000 });
      await vi.waitFor(() => expect(frame()).toContain('Waiting for your answer'));
      screen.stdin.write('approve');
      await vi.waitFor(() => expect(frame()).toContain('> approve'));
      screen.stdin.write('\r');
      await vi.waitFor(() => expect(frame()).toContain('Seat changes after T001'));
      const shown = screen.frames.slice(firstFrame).map(stripAnsiStyles).join('\n');
      expect(shown).not.toContain('Finishing');
      expect(shown).not.toContain('Pause requested');
      briefReadNow();

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

it('keeps the BUILD seat timeout in config.yaml when switch-seat moves the seat, and the run goes on', {
  timeout: 240_000,
}, async () => {
  const { target, codexCalls, claudeCalls } = await codexSeatFixture(false, PRIMARY_MODEL);
  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    implementer: { ...config.implementer, timeout: 1_800_000 },
  });
  const configPath = join(target.projectDir, CONFIG_RELATIVE_PATH);
  expect(readFileSync(configPath, 'utf8')).toMatch(/^\s+timeout: 1800000$/m);
  const options = { timeoutMs: 90_000, reapProjectDir: target.projectDir };
  const halted = await cli(target, ['start', 'smoke'], options);
  expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
  expect(halted.stderr).toContain('Seat down (runner-usage-limit)');
  const sessionId = readdirSync(sessionsRoot(target.projectDir))[0] ?? '';

  const switched = await cli(
    target,
    ['continue', sessionId, '--action', `switch-seat:claude-code:${SWITCHED_MODEL}`],
    options,
  );

  expect(switched.exitCode, `${switched.stdout}\n${switched.stderr}`).toBe(0);
  expect(switched.stderr).toContain(`BUILD seat recorded in ${CONFIG_RELATIVE_PATH}`);
  expect(readFileSync(configPath, 'utf8')).toMatch(/^\s+timeout: 1800000$/m);
  expect(loadConfig(target.projectDir).config.implementer).toMatchObject({
    kind: 'cli',
    tool: 'claude-code',
    model: SWITCHED_MODEL,
    timeout: 1_800_000,
  });
  expect(switched.stdout).toContain('task T001: done');
  expect(loadState({ projectDir: target.projectDir, sessionId })?.phase).toBe('complete');
  expect(recordedCalls(codexCalls)).toEqual([{ model: PRIMARY_MODEL }]);
  expect(recordedCalls(claudeCalls)).toEqual([
    { model: SWITCHED_MODEL, prompt: expect.stringContaining(GREET_FILE) },
  ]);
});

it('keeps the BUILD seat idle limit in config.yaml when its fallback moves it to another model of its tool', {
  timeout: 240_000,
}, async () => {
  const { target, codexCalls, claudeCalls } = await codexSeatFixture(false, 'gpt-5.1-codex');
  const config = loadConfig(target.projectDir).config;
  const implementer = config.implementer;
  if (implementer.kind !== 'cli') throw new Error('expected a cli BUILD seat');
  writeConfig(target.projectDir, {
    ...config,
    implementer: {
      ...implementer,
      idleKillMs: 900_000,
      fallback: { tool: 'codex', model: PRIMARY_MODEL },
    },
  });
  const configPath = join(target.projectDir, CONFIG_RELATIVE_PATH);
  expect(readFileSync(configPath, 'utf8')).toMatch(/^\s+idle_kill_ms: 900000$/m);

  const options = { timeoutMs: 90_000, reapProjectDir: target.projectDir };
  const halted = await cli(target, ['start', 'smoke'], options);

  const sessionId = readdirSync(sessionsRoot(target.projectDir))[0] ?? '';
  const state = loadState({ projectDir: target.projectDir, sessionId });
  expect(halted.stderr).toContain('Seat down (runner-usage-limit)');
  expect(state?.seatSwitches).toEqual([
    expect.objectContaining({ seat: 'build', cause: 'runner-usage-limit', auto: true }),
  ]);
  expect(recordedCalls(codexCalls)).toEqual([{ model: 'gpt-5.1-codex' }, { model: PRIMARY_MODEL }]);
  expect(existsSync(claudeCalls)).toBe(false);
  expect(readFileSync(configPath, 'utf8')).toMatch(/^\s+idle_kill_ms: 900000$/m);
  expect(loadConfig(target.projectDir).config.implementer).toEqual({
    kind: 'cli',
    tool: 'codex',
    model: PRIMARY_MODEL,
    contextLength: 200_000,
    idleKillMs: 900_000,
    fallback: { tool: 'codex', model: 'gpt-5.1-codex' },
  });
});

it('keeps the custom models of the BUILD seat saved under the halt when Change BUILD tool moves the seat to it', {
  timeout: 150_000,
}, async () => {
  const { target, sessionId, claudeCalls } = await codexHaltFixture();
  vi.stubGlobal('fetch', async () => {
    throw new Error('Network disabled in seat switch E2E');
  });
  await trustDeclaredRunners({
    projectDir: target.projectDir,
    config: loadConfig(target.projectDir).config,
  });
  const { screen } = await openHaltedRun(target, {
    heading: 'Seat down',
    prepare: ({ ref, state }) => preparedResume(ref, state),
    runWorkflow,
  });
  const frame = () => stripAnsiStyles(screen.lastFrame());
  const press = async (key: string) => {
    screen.stdin.write(key);
    await flushEffects();
    await tick(100);
  };
  try {
    const current = configStore.get().config;
    if (current === null) throw new Error('the screen loaded no config');
    const saved = await configStore.save({
      ...current,
      implementer: {
        kind: 'cli',
        tool: 'claude-code',
        model: SWITCHED_MODEL,
        contextLength: 200_000,
        customModels: ['my-a'],
      },
    });
    expect(saved.kind).toBe('saved');
    await flushEffects();

    await press('\r');
    await vi.waitFor(() => expect(frame()).toContain('BUILD · tool, model, effort'));
    await press('\u0012');
    await vi.waitFor(() => expect(frame()).toContain('claude-opus-5-5'), { timeout: 30_000 });
    // The picker opens on the saved Sonnet row; ⏎ opens its effort and ⏎ takes the row.
    await press('\r');
    await press('\r');
    await vi.waitFor(() => expect(overlayStore.get().active).toBe('none'));

    const ref = { projectDir: target.projectDir, sessionId };
    await vi.waitFor(() => expect(loadState(ref)?.phase).toBe('complete'), { timeout: 60_000 });
    expect(loadState(ref)?.seatSwitches).toEqual([
      expect.objectContaining({ seat: 'build', cause: 'runner-usage-limit', auto: false }),
    ]);
    expect(recordedCalls(claudeCalls)).toEqual([
      { model: SWITCHED_MODEL, prompt: expect.stringContaining(GREET_FILE) },
    ]);
    expect(readFileSync(join(target.projectDir, CONFIG_RELATIVE_PATH), 'utf8')).toMatch(
      /^\s+custom_models:\n\s+- my-a$/m,
    );
    expect(loadConfig(target.projectDir).config.implementer).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: SWITCHED_MODEL,
      contextLength: 200_000,
      customModels: ['my-a'],
    });
  } finally {
    screen.unmount();
  }
});
